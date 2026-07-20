import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/server.mjs';
import { openDatabase } from '../backend/db.mjs';
import { runWorker } from '../worker/worker.mjs';

const silentLogger = { error() {}, warn() {} };

async function waitFor(check, { timeoutMs = 3_000, intervalMs = 10, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}; last value: ${JSON.stringify(lastValue)}`);
}

async function createApiFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'statusscreen-worker-api-'));
  const dbPath = join(directory, 'statusscreen.db');
  const store = openDatabase({ path: dbPath });
  const server = createServer({ store, logger: silentLogger, workerStaleMs: 1_000 });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const json = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  };
  return { directory, dbPath, store, server, baseUrl, json };
}

test('worker processes selected connected channels and API reports live heartbeat', async (t) => {
  const fixture = await createApiFixture(t);
  const created = await fixture.json('/api/projects', {
    method: 'POST',
    body: { title: '차가운 커피 레시피', channelIds: ['youtube', 'tiktok'] },
  });
  assert.equal(created.response.status, 202);

  const worker = runWorker({
    dbPath: fixture.dbPath,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 10,
    retryDelayMs: 5,
    processingDelayMs: 10,
    logger: silentLogger,
  });
  t.after(() => worker.stop());
  await worker.ready;

  const liveHealth = await fixture.json('/api/health');
  assert.equal(liveHealth.body.worker.status, 'online');
  assert.equal(liveHealth.body.worker.workerId, worker.workerId);
  assert.ok(liveHealth.body.worker.heartbeatAgeMs >= 0);

  const completedJob = await waitFor(async () => {
    const result = await fixture.json(`/api/jobs/${created.body.job.id}`);
    return result.body.job.status === 'completed' ? result.body.job : null;
  }, { message: 'project job completion' });
  assert.equal(completedJob.progress, 100);
  assert.equal(completedJob.attempts, 1);
  assert.ok(completedJob.startedAt);
  assert.ok(completedJob.completedAt);

  const project = await fixture.json(`/api/projects/${created.body.project.id}`);
  assert.equal(project.body.project.status, 'ready');
  assert.equal(project.body.project.content.length, 2);
  assert.deepEqual(
    project.body.project.content.map((item) => item.channelId).sort(),
    ['tiktok', 'youtube'],
  );

  const generatedContent = await fixture.json(`/api/content?search=${encodeURIComponent('차가운 커피')}`);
  assert.equal(generatedContent.body.content.length, 2);
  const allHooks = await fixture.json('/api/hook-tests?status=running');
  const generatedHooks = allHooks.body.hookTests.filter(
    (hook) => hook.contentId.includes(created.body.project.id),
  );
  assert.equal(generatedHooks.length, 2);
  assert.ok(generatedHooks.every((hook) => hook.variants.length === 3));
  assert.ok(generatedHooks.every((hook) => hook.variants.reduce((sum, item) => sum + item.score, 0) === 100));

  await worker.stop();
  const stoppedHealth = await fixture.json('/api/health');
  assert.equal(stoppedHealth.body.worker.status, 'stopped');
  assert.ok(stoppedHealth.body.worker.stoppedAt);
});

test('worker retries deterministic failures to maxAttempts and retry endpoint creates a fresh job', async (t) => {
  const fixture = await createApiFixture(t);
  const worker = runWorker({
    dbPath: fixture.dbPath,
    pollIntervalMs: 5,
    retryDelayMs: 5,
    heartbeatIntervalMs: 10,
    logger: silentLogger,
  });
  t.after(() => worker.stop());
  await worker.ready;

  const created = await fixture.json('/api/projects', {
    method: 'POST',
    body: { title: '[fail] 재시도 검증', channelIds: ['instagram'] },
  });
  const failed = await waitFor(async () => {
    const result = await fixture.json(`/api/jobs/${created.body.job.id}`);
    return result.body.job.status === 'failed' ? result.body.job : null;
  }, { message: 'deterministic job failure' });
  assert.equal(failed.attempts, 3);
  assert.equal(failed.maxAttempts, 3);
  assert.match(failed.lastError, /Deterministic project failure/);
  assert.ok(failed.completedAt);

  const failedProject = await fixture.json(`/api/projects/${created.body.project.id}`);
  assert.equal(failedProject.body.project.status, 'failed');
  assert.match(failedProject.body.project.error, /\[fail\]/);
  assert.equal(failedProject.body.project.content.length, 0);

  const retried = await fixture.json(`/api/projects/${created.body.project.id}/retry`, {
    method: 'POST',
  });
  assert.equal(retried.response.status, 202);
  assert.notEqual(retried.body.job.id, created.body.job.id);
  assert.equal(retried.body.job.attempts, 0);
  assert.equal(retried.body.project.status, 'queued');

  const failedAgain = await waitFor(async () => {
    const result = await fixture.json(`/api/jobs/${retried.body.job.id}`);
    return result.body.job.status === 'failed' ? result.body.job : null;
  }, { message: 'retried deterministic job failure' });
  assert.equal(failedAgain.attempts, 3);
  assert.match(failedAgain.lastError, /\[fail\]/);

  const retryWhileFailed = await fixture.json(`/api/projects/${created.body.project.id}/retry`, {
    method: 'POST',
  });
  assert.equal(retryWhileFailed.response.status, 202);
  await worker.stop();
});

test('startup recovers a stale claimed job and accounts for the abandoned attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'statusscreen-stale-'));
  const dbPath = join(directory, 'statusscreen.db');
  const observer = openDatabase({ path: dbPath });
  let worker;
  try {
    const created = observer.createProject({
      title: 'stale job recovery',
      channelIds: ['youtube'],
      maxAttempts: 3,
    });
    const abandoned = observer.claimNextJob('worker-that-disappeared');
    assert.equal(abandoned.attempts, 1);
    observer.db.prepare(`
      UPDATE jobs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(created.job.id);

    worker = runWorker({
      dbPath,
      pollIntervalMs: 5,
      retryDelayMs: 5,
      staleAfterMs: 1,
      logger: silentLogger,
    });
    await worker.ready;
    const recovered = await waitFor(() => {
      const job = observer.getJob(created.job.id);
      return job.status === 'completed' ? job : null;
    }, { message: 'stale job recovery' });
    assert.equal(recovered.attempts, 2);
    assert.equal(observer.getProject(created.project.id).status, 'ready');
  } finally {
    await worker?.stop();
    observer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a running worker periodically recovers jobs abandoned after startup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'statusscreen-periodic-recovery-'));
  const dbPath = join(directory, 'statusscreen.db');
  const observer = openDatabase({ path: dbPath });
  let worker;
  try {
    worker = runWorker({
      dbPath,
      pollIntervalMs: 5,
      staleAfterMs: 20,
      logger: silentLogger,
    });
    await worker.ready;
    const created = observer.createProject({
      title: 'periodic stale recovery',
      channelIds: ['instagram'],
    });
    const abandoned = observer.claimNextJob('worker-that-failed-later');
    assert.equal(abandoned.id, created.job.id);
    observer.db.prepare(`
      UPDATE jobs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(created.job.id);

    const recovered = await waitFor(() => {
      const job = observer.getJob(created.job.id);
      return job.status === 'completed' ? job : null;
    }, { timeoutMs: 2_500, message: 'periodic stale job recovery' });
    assert.equal(recovered.attempts, 2);
    assert.equal(observer.getProject(created.project.id).status, 'ready');
  } finally {
    await worker?.stop();
    observer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('graceful stop finishes an active job before marking the worker stopped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'statusscreen-graceful-'));
  const dbPath = join(directory, 'statusscreen.db');
  const observer = openDatabase({ path: dbPath });
  let worker;
  try {
    const created = observer.createProject({
      title: 'graceful lifecycle',
      channelIds: ['youtube', 'instagram'],
    });
    worker = runWorker({
      dbPath,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10,
      processingDelayMs: 60,
      logger: silentLogger,
    });
    await worker.ready;
    await waitFor(() => observer.getJob(created.job.id).status === 'processing', {
      message: 'active processing state',
    });
    await worker.stop();
    assert.equal(observer.getJob(created.job.id).status, 'completed');
    assert.equal(observer.getProject(created.project.id).status, 'ready');
    assert.equal(observer.getWorkerState().status, 'stopped');
  } finally {
    await worker?.stop();
    observer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite settings and persisted records survive reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'statusscreen-persistence-'));
  const dbPath = join(directory, 'statusscreen.db');
  try {
    const first = openDatabase({ path: dbPath });
    const created = first.createProject({ title: 'persistent project', channelIds: ['tiktok'] });
    first.close();

    const reopened = openDatabase({ path: dbPath, seed: false });
    try {
      assert.equal(reopened.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(reopened.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(reopened.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
      assert.equal(reopened.getProject(created.project.id).title, 'persistent project');
      assert.equal(reopened.getJob(created.job.id).status, 'queued');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
