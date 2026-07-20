import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openDatabase, StoreError } from './db.mjs';

const DEFAULT_BODY_LIMIT = 1_048_576;
const CONTENT_STATUSES = new Set(['draft', 'testing', 'scheduled', 'published']);
const HOOK_STATUSES = new Set(['running', 'completed']);
const PROJECT_STATUSES = new Set(['queued', 'processing', 'ready', 'failed']);
const SCHEDULE_STATUSES = new Set(['scheduled', 'published', 'cancelled']);

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value) {
  if (!isPlainObject(value)) {
    throw new ApiError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }
}

function requireString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must be between ${min} and ${max} characters.`, {
      field,
    });
  }
  return value.trim();
}

function optionalString(value, field, options = {}) {
  if (value === undefined) return undefined;
  if (value === null && options.nullable) return null;
  return requireString(value, field, options);
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must be a boolean.`, { field });
  }
  return value;
}

function optionalInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must be an integer between ${min} and ${max}.`, {
      field,
    });
  }
  return value;
}

function validateRange(value) {
  const range = value === null ? 7 : Number(value);
  if (range !== 7 && range !== 30) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'range must be 7 or 30.', { field: 'range' });
  }
  return range;
}

function validateEnum(value, field, allowed) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!allowed.has(value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} has an unsupported value.`, {
      field,
      allowed: [...allowed],
    });
  }
  return value;
}

function getLocalCorsOrigin(origin) {
  if (!origin) return null;
  if (origin === 'null') return origin;
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin) ? origin : null;
}

function setCorsHeaders(req, res) {
  const allowedOrigin = getLocalCorsOrigin(req.headers.origin);
  if (allowedOrigin) {
    res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Content-Type, X-Request-Id');
  res.setHeader('access-control-expose-headers', 'X-Request-Id');
  res.setHeader('access-control-max-age', '600');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

function sendError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const code = error.code || 'INTERNAL_ERROR';
  const message = status >= 500 ? 'An unexpected server error occurred.' : error.message;
  const payload = { error: { code, message } };
  if (error.details !== undefined && status < 500) payload.error.details = error.details;
  sendJson(res, status, payload);
}

async function readJson(req, limit) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    req.resume();
    throw new ApiError(413, 'BODY_TOO_LARGE', `Request body exceeds the ${limit}-byte limit.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new ApiError(413, 'BODY_TOO_LARGE', `Request body exceeds the ${limit}-byte limit.`);
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new ApiError(400, 'INVALID_BODY', 'Request body is required.');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assertObject(value);
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_JSON', 'Request body contains invalid JSON.');
  }
}

function routeId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const remainder = pathname.slice(prefix.length);
  if (!remainder || remainder.includes('/')) return null;
  try {
    return decodeURIComponent(remainder);
  } catch {
    throw new ApiError(400, 'INVALID_PATH', 'URL path contains invalid encoding.');
  }
}

function decodePathComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'INVALID_PATH', 'URL path contains invalid encoding.');
  }
}

function requireExistingChannel(store, channelId, { connected = false } = {}) {
  const channel = store.getChannel(channelId);
  if (!channel) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'channelId does not identify a channel.', {
      field: 'channelId', channelId,
    });
  }
  if (connected && !channel.connected) {
    throw new ApiError(422, 'CHANNEL_DISCONNECTED', 'Selected channel is not connected.', { channelId });
  }
  return channel;
}

function validateProjectBody(body, store) {
  const title = requireString(body.title, 'title', { min: 1, max: 160 });
  const rawChannelIds = body.channelIds ?? body.selectedChannelIds;
  if (!Array.isArray(rawChannelIds) || rawChannelIds.length === 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'channelIds must contain at least one channel id.', {
      field: 'channelIds',
    });
  }
  if (rawChannelIds.some((id) => typeof id !== 'string')) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Every channel id must be a string.', {
      field: 'channelIds',
    });
  }
  const channelIds = [...new Set(rawChannelIds)];
  if (channelIds.length !== rawChannelIds.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'channelIds must not contain duplicates.', {
      field: 'channelIds',
    });
  }
  const invalid = channelIds.filter((id) => {
    const channel = store.getChannel(id);
    return !channel || !channel.connected;
  });
  if (invalid.length) {
    throw new ApiError(422, 'INVALID_CHANNELS', 'All selected channels must exist and be connected.', {
      channelIds: invalid,
    });
  }
  return { title, channelIds };
}

function validateScheduleBody(body, store) {
  const title = requireString(body.title, 'title', { max: 160 });
  const channelId = requireString(body.channelId, 'channelId', { max: 80 });
  requireExistingChannel(store, channelId, { connected: true });
  const scheduledAt = requireString(body.scheduledAt, 'scheduledAt', { max: 64 });
  const parsedDate = new Date(scheduledAt);
  if (Number.isNaN(parsedDate.valueOf())) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'scheduledAt must be a valid ISO date.', {
      field: 'scheduledAt',
    });
  }
  const timezone = optionalString(body.timezone, 'timezone', { max: 80 }) || 'Asia/Seoul';
  const status = validateEnum(body.status, 'status', SCHEDULE_STATUSES) || 'scheduled';
  const contentId = body.contentId === null || body.contentId === undefined
    ? null
    : requireString(body.contentId, 'contentId', { max: 120 });
  if (contentId && !store.getContent(contentId)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'contentId does not identify content.', {
      field: 'contentId', contentId,
    });
  }
  return { contentId, channelId, title, scheduledAt: parsedDate.toISOString(), timezone, status };
}

function validateTemplateBody(body) {
  return {
    name: requireString(body.name, 'name', { max: 100 }),
    category: requireString(body.category, 'category', { max: 60 }),
    body: requireString(body.body, 'body', { max: 2000 }),
    isDefault: optionalBoolean(body.isDefault, 'isDefault') ?? false,
  };
}

function deleteId(url, pathname, prefix) {
  return routeId(pathname, prefix) || url.searchParams.get('id');
}

async function handleRequest(req, res, context) {
  const { store, bodyLimit, workerStaleMs } = context;
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    sendNoContent(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    const worker = store.getWorkerState();
    const heartbeatAgeMs = worker ? Date.now() - Date.parse(worker.heartbeatAt) : null;
    const workerHealth = !worker
      ? 'offline'
      : worker.status === 'running' && heartbeatAgeMs <= workerStaleMs
        ? 'online'
        : worker.status === 'stopped'
          ? 'stopped'
          : 'stale';
    sendJson(res, 200, {
      status: 'ok',
      database: { status: store.ping() ? 'ok' : 'error' },
      worker: { ...worker, status: workerHealth, heartbeatAgeMs },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/dashboard') {
    sendJson(res, 200, { dashboard: store.getDashboard(validateRange(url.searchParams.get('range'))) });
    return;
  }

  if (pathname === '/api/projects') {
    if (req.method === 'GET') {
      const status = validateEnum(url.searchParams.get('status'), 'status', PROJECT_STATUSES);
      sendJson(res, 200, { projects: store.listProjects({ status }) });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req, bodyLimit);
      const result = store.createProject(validateProjectBody(body, store));
      sendJson(res, 202, result);
      return;
    }
  }

  const retryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/retry$/);
  if (retryMatch && req.method === 'POST') {
    const id = decodePathComponent(retryMatch[1]);
    sendJson(res, 202, store.retryProject(id));
    return;
  }

  const projectId = routeId(pathname, '/api/projects/');
  if (projectId && req.method === 'GET') {
    const project = store.getProject(projectId);
    if (!project) throw new ApiError(404, 'NOT_FOUND', 'Project not found.');
    sendJson(res, 200, { project });
    return;
  }

  const jobId = routeId(pathname, '/api/jobs/');
  if (jobId && req.method === 'GET') {
    const job = store.getJob(jobId);
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Job not found.');
    sendJson(res, 200, { job });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/content') {
    const search = url.searchParams.get('search')?.trim() || undefined;
    const status = validateEnum(url.searchParams.get('status'), 'status', CONTENT_STATUSES);
    const channel = url.searchParams.get('channel') || undefined;
    if (channel) requireExistingChannel(store, channel);
    sendJson(res, 200, { content: store.listContent({ search, status, channel }) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/hook-tests') {
    const status = validateEnum(url.searchParams.get('status'), 'status', HOOK_STATUSES);
    const channel = url.searchParams.get('channel') || undefined;
    if (channel) requireExistingChannel(store, channel);
    sendJson(res, 200, { hookTests: store.listHookTests({ status, channel }) });
    return;
  }

  if (pathname === '/api/schedules') {
    if (req.method === 'GET') {
      sendJson(res, 200, { schedules: store.listSchedules() });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req, bodyLimit);
      sendJson(res, 201, { schedule: store.createSchedule(validateScheduleBody(body, store)) });
      return;
    }
    if (req.method === 'DELETE') {
      const body = req.headers['content-length'] === '0' || !req.headers['content-type']
        ? null
        : await readJson(req, bodyLimit);
      const id = url.searchParams.get('id') || body?.id;
      if (!id) throw new ApiError(422, 'VALIDATION_ERROR', 'A schedule id is required.', { field: 'id' });
      if (!store.deleteSchedule(id)) throw new ApiError(404, 'NOT_FOUND', 'Schedule not found.');
      sendNoContent(res);
      return;
    }
  }

  const scheduleId = deleteId(url, pathname, '/api/schedules/');
  if (scheduleId && req.method === 'DELETE') {
    if (!store.deleteSchedule(scheduleId)) throw new ApiError(404, 'NOT_FOUND', 'Schedule not found.');
    sendNoContent(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/analytics') {
    sendJson(res, 200, { analytics: store.getAnalytics(validateRange(url.searchParams.get('range'))) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/channels') {
    sendJson(res, 200, { channels: store.listChannels() });
    return;
  }

  const channelId = routeId(pathname, '/api/channels/');
  if (channelId) {
    if (req.method === 'GET') {
      const channel = store.getChannel(channelId);
      if (!channel) throw new ApiError(404, 'NOT_FOUND', 'Channel not found.');
      sendJson(res, 200, { channel });
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req, bodyLimit);
      const changes = {
        handle: optionalString(body.handle, 'handle', { max: 100 }),
        connected: optionalBoolean(body.connected, 'connected'),
      };
      if (Object.values(changes).every((value) => value === undefined)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'At least one channel field is required.');
      }
      sendJson(res, 200, { channel: store.updateChannel(channelId, changes) });
      return;
    }
  }

  if (pathname === '/api/templates') {
    if (req.method === 'GET') {
      sendJson(res, 200, { templates: store.listTemplates() });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req, bodyLimit);
      sendJson(res, 201, { template: store.createTemplate(validateTemplateBody(body)) });
      return;
    }
    if (req.method === 'DELETE') {
      const body = req.headers['content-length'] === '0' || !req.headers['content-type']
        ? null
        : await readJson(req, bodyLimit);
      const id = url.searchParams.get('id') || body?.id;
      if (!id) throw new ApiError(422, 'VALIDATION_ERROR', 'A template id is required.', { field: 'id' });
      if (!store.deleteTemplate(id)) throw new ApiError(404, 'NOT_FOUND', 'Template not found.');
      sendNoContent(res);
      return;
    }
  }

  const templateId = deleteId(url, pathname, '/api/templates/');
  if (templateId && req.method === 'DELETE') {
    if (!store.deleteTemplate(templateId)) throw new ApiError(404, 'NOT_FOUND', 'Template not found.');
    sendNoContent(res);
    return;
  }

  if (pathname === '/api/brand') {
    if (req.method === 'GET') {
      sendJson(res, 200, { brand: store.getBrand() });
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req, bodyLimit);
      const changes = {
        name: optionalString(body.name, 'name', { max: 100 }),
        voice: optionalString(body.voice, 'voice', { max: 300 }),
        primaryColor: optionalString(body.primaryColor, 'primaryColor', { max: 20 }),
        logoUrl: optionalString(body.logoUrl, 'logoUrl', { max: 1000, nullable: true }),
      };
      if (changes.primaryColor && !/^#[0-9a-f]{6}$/i.test(changes.primaryColor)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'primaryColor must be a six-digit hex color.', {
          field: 'primaryColor',
        });
      }
      if (Object.values(changes).every((value) => value === undefined)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'At least one brand field is required.');
      }
      sendJson(res, 200, { brand: store.updateBrand(changes) });
      return;
    }
  }

  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, { settings: store.getSettings() });
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req, bodyLimit);
      const changes = {
        locale: optionalString(body.locale, 'locale', { max: 30 }),
        timezone: optionalString(body.timezone, 'timezone', { max: 80 }),
        emailNotifications: optionalBoolean(body.emailNotifications, 'emailNotifications'),
        autoSchedule: optionalBoolean(body.autoSchedule, 'autoSchedule'),
      };
      if (Object.values(changes).every((value) => value === undefined)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'At least one settings field is required.');
      }
      sendJson(res, 200, { settings: store.updateSettings(changes) });
      return;
    }
  }

  if (pathname === '/api/plan') {
    if (req.method === 'GET') {
      sendJson(res, 200, { plan: store.getPlan() });
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req, bodyLimit);
      const changes = {
        name: optionalString(body.name, 'name', { max: 100 }),
        daysRemaining: optionalInteger(body.daysRemaining, 'daysRemaining', { min: 0, max: 3650 }),
        usagePercent: optionalInteger(body.usagePercent, 'usagePercent', { min: 0, max: 100 }),
        projectLimit: optionalInteger(body.projectLimit, 'projectLimit', { min: 1, max: 1_000_000 }),
      };
      if (Object.values(changes).every((value) => value === undefined)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'At least one plan field is required.');
      }
      sendJson(res, 200, { plan: store.updatePlan(changes) });
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/api/notifications') {
    sendJson(res, 200, { notifications: store.listNotifications() });
    return;
  }

  const notificationMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (notificationMatch && req.method === 'POST') {
    const notification = store.readNotification(decodePathComponent(notificationMatch[1]));
    if (!notification) throw new ApiError(404, 'NOT_FOUND', 'Notification not found.');
    sendJson(res, 200, { notification });
    return;
  }

  const knownPath = pathname.startsWith('/api/');
  throw new ApiError(
    knownPath ? 404 : 404,
    'NOT_FOUND',
    knownPath ? 'API route not found.' : 'This server exposes JSON API routes only.',
  );
}

export function createServer(options = {}) {
  const ownsStore = !options.store;
  const store = options.store || openDatabase({ path: options.dbPath, seed: options.seed ?? true });
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const workerStaleMs = options.workerStaleMs ?? 15_000;
  const logger = options.logger || console;
  const server = createHttpServer((req, res) => {
    const incomingRequestId = req.headers['x-request-id'];
    const requestId = typeof incomingRequestId === 'string' && incomingRequestId.length <= 128
      ? incomingRequestId
      : randomUUID();
    res.setHeader('x-request-id', requestId);
    setCorsHeaders(req, res);
    Promise.resolve(handleRequest(req, res, { store, bodyLimit, workerStaleMs })).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (!(error instanceof ApiError) && !(error instanceof StoreError)) {
        logger.error?.({ requestId, error }, 'Unhandled API request error');
      }
      sendError(res, error);
    });
  });

  server.store = store;
  server.on('clientError', (error, socket) => {
    logger.warn?.({ error }, 'HTTP client error');
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  if (ownsStore) server.on('close', () => store.close());
  return server;
}

async function startDirectServer() {
  const host = process.env.HOST || '127.0.0.1';
  const parsedPort = Number(process.env.PORT || 3000);
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(parsedPort, host, resolve);
  });
  const address = server.address();
  console.log(`StatusScreen API listening on http://${host}:${address.port}`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}; closing API server.`);
    await new Promise((resolve) => server.close(resolve));
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  startDirectServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
