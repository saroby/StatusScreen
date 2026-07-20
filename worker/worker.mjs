import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../backend/db.mjs';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function makeInterruptibleDelay(milliseconds, registerWake) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      registerWake(null);
      resolve();
    }, milliseconds);
    registerWake(() => {
      clearTimeout(timer);
      registerWake(null);
      resolve();
    });
  });
}

function generatedHooksFor(title, channelId) {
  const prefixes = {
    youtube: ['99%가 놓친', '의외로 간단한', '보고도 믿기 힘든'],
    instagram: ['저장하고 싶은', '친구에게 보내고 싶은', '오늘 바로 따라 하는'],
    tiktok: ['3초 만에 빠져드는', '끝까지 보게 되는', '지금 뜨는'],
  };
  const scores = {
    youtube: [52, 31, 17],
    instagram: [55, 28, 17],
    tiktok: [59, 26, 15],
  };
  const channelPrefixes = prefixes[channelId] || ['놓치면 아쉬운', '바로 써먹는', '새롭게 보는'];
  const channelScores = scores[channelId] || [54, 29, 17];
  return channelPrefixes.map((prefix, index) => ({
    caption: `${prefix} ${title}`,
    score: channelScores[index],
  }));
}

async function processJob(store, job, options) {
  const { workerId, processingDelayMs, heartbeatIntervalMs, startedAt } = options;
  if (job.type !== 'process_project') {
    throw new Error(`Unsupported job type: ${job.type}`);
  }
  const project = store.getProject(job.projectId);
  if (!project) throw new Error(`Project ${job.projectId} no longer exists.`);
  if (!Array.isArray(job.payload.channelIds) || job.payload.channelIds.length === 0) {
    throw new Error('Job payload does not contain channelIds.');
  }

  let progress = 10;
  store.heartbeatJob(job.id, workerId, progress);
  const heartbeat = setInterval(() => {
    store.updateWorkerHeartbeat({ workerId, status: 'running', startedAt });
    store.heartbeatJob(job.id, workerId, progress);
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  try {
    if (processingDelayMs > 0) await delay(processingDelayMs);
    if (project.title.toLowerCase().includes('[fail]')) {
      throw new Error('Deterministic project failure requested by [fail].');
    }

    progress = 40;
    store.heartbeatJob(job.id, workerId, progress);
    const channelIds = job.payload.channelIds;
    const generatedHooks = Object.fromEntries(
      channelIds.map((channelId) => [channelId, generatedHooksFor(project.title, channelId)]),
    );
    if (processingDelayMs > 0) await delay(processingDelayMs);
    progress = 80;
    store.heartbeatJob(job.id, workerId, progress);
    return store.completeProjectJob({
      jobId: job.id,
      workerId,
      projectId: project.id,
      title: project.title,
      channelIds,
      generatedHooks,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

export function runWorker(options = {}) {
  const ownsStore = !options.store;
  const store = options.store || openDatabase({ path: options.dbPath, seed: options.seed ?? true });
  const workerId = options.workerId || `worker-${process.pid}-${randomUUID()}`;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const processingDelayMs = options.processingDelayMs ?? 0;
  const logger = options.logger || console;
  const startedAt = new Date().toISOString();
  let stopping = false;
  let wake = null;
  let lastRecoveryAt = 0;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const done = (async () => {
    try {
      store.updateWorkerHeartbeat({ workerId, status: 'starting', startedAt });
      store.recoverStaleJobs({ staleAfterMs });
      store.updateWorkerHeartbeat({ workerId, status: 'running', startedAt });
      resolveReady();

      while (!stopping) {
        store.updateWorkerHeartbeat({ workerId, status: 'running', startedAt });
        if (Date.now() - lastRecoveryAt >= Math.max(1_000, staleAfterMs / 2)) {
          store.recoverStaleJobs({ staleAfterMs });
          lastRecoveryAt = Date.now();
        }
        const job = store.claimNextJob(workerId);
        if (!job) {
          await makeInterruptibleDelay(pollIntervalMs, (nextWake) => {
            wake = nextWake;
          });
          continue;
        }
        try {
          await processJob(store, job, {
            workerId,
            processingDelayMs,
            heartbeatIntervalMs,
            startedAt,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          store.failJob({ jobId: job.id, workerId, error: message, retryDelayMs });
          logger.warn?.({ jobId: job.id, error: message }, 'Worker job failed');
        }
      }
      store.updateWorkerHeartbeat({ workerId, status: 'stopping', startedAt });
      store.updateWorkerHeartbeat({ workerId, status: 'stopped', startedAt });
    } catch (error) {
      rejectReady(error);
      throw error;
    } finally {
      if (ownsStore) store.close();
    }
  })();

  return {
    workerId,
    ready,
    done,
    async stop() {
      if (stopping) return done;
      stopping = true;
      wake?.();
      return done;
    },
  };
}

async function startDirectWorker() {
  const handle = runWorker();
  await handle.ready;
  console.log(`StatusScreen worker ${handle.workerId} is running.`);
  let shutdownStarted = false;
  const shutdown = async (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`Received ${signal}; stopping worker after the active job.`);
    await handle.stop();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await handle.done;
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  startDirectWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
