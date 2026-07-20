import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/server.mjs';
import { openDatabase } from '../backend/db.mjs';

const silentLogger = { error() {}, warn() {} };

async function createFixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'statusscreen-api-'));
  const dbPath = join(directory, 'statusscreen.db');
  const store = openDatabase({ path: dbPath });
  const server = createServer({ store, logger: silentLogger, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, options);
    const text = await response.text();
    return {
      response,
      body: text ? JSON.parse(text) : null,
    };
  }

  async function json(path, { method = 'GET', body, headers = {} } = {}) {
    return request(path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  return { directory, dbPath, store, server, baseUrl, request, json };
}

test('health, CORS, request IDs, seed dashboard, analytics, and JSON-only 404s', async (t) => {
  const fixture = await createFixture(t);

  const health = await fixture.json('/api/health', {
    headers: {
      origin: 'http://localhost:5173',
      'x-request-id': 'integration-request-id',
    },
  });
  assert.equal(health.response.status, 200);
  assert.equal(health.response.headers.get('x-request-id'), 'integration-request-id');
  assert.equal(health.response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.database.status, 'ok');
  assert.equal(health.body.worker.status, 'offline');

  const preflight = await fixture.request('/api/projects', {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:4173' },
  });
  assert.equal(preflight.response.status, 204);
  assert.match(preflight.response.headers.get('access-control-allow-methods'), /POST/);

  const dashboard = await fixture.json('/api/dashboard?range=7');
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.dashboard.channels.length, 3);
  assert.deepEqual(dashboard.body.dashboard.channels.map((channel) => channel.id), [
    'youtube', 'instagram', 'tiktok',
  ]);
  assert.equal(dashboard.body.dashboard.analytics.views, 2_814_000);
  assert.equal(dashboard.body.dashboard.hookTests.length, 3);
  assert.equal(dashboard.body.dashboard.unreadNotifications, 3);

  const analytics = await fixture.json('/api/analytics?range=30');
  assert.equal(analytics.body.analytics.views, 11_240_000);
  assert.equal(analytics.body.analytics.likes, 863_000);
  assert.equal(analytics.body.analytics.averageViewRate, 109);
  assert.equal(analytics.body.analytics.newFollowers, 128_000);
  assert.deepEqual(
    analytics.body.analytics.channels.map((channel) => channel.id),
    ['youtube', 'instagram', 'tiktok'],
  );
  assert.ok(analytics.body.analytics.channels.every((channel) => channel.views > 0));

  const badRange = await fixture.json('/api/dashboard?range=14');
  assert.equal(badRange.response.status, 422);
  assert.deepEqual(badRange.body.error, {
    code: 'VALIDATION_ERROR',
    message: 'range must be 7 or 30.',
    details: { field: 'range' },
  });

  const unknown = await fixture.json('/api/missing');
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error.code, 'NOT_FOUND');
  const html = await fixture.json('/');
  assert.equal(html.response.status, 404);
  assert.match(html.body.error.message, /JSON API/);
});

test('project API validates input and persists project plus queued job atomically', async (t) => {
  const fixture = await createFixture(t);

  const missingTitle = await fixture.json('/api/projects', {
    method: 'POST',
    body: { channelIds: ['youtube'] },
  });
  assert.equal(missingTitle.response.status, 422);
  assert.equal(missingTitle.body.error.code, 'VALIDATION_ERROR');

  const duplicateChannels = await fixture.json('/api/projects', {
    method: 'POST',
    body: { title: '중복 채널', channelIds: ['youtube', 'youtube'] },
  });
  assert.equal(duplicateChannels.response.status, 422);

  const unknownChannel = await fixture.json('/api/projects', {
    method: 'POST',
    body: { title: '없는 채널', channelIds: ['missing'] },
  });
  assert.equal(unknownChannel.response.status, 422);
  assert.equal(unknownChannel.body.error.code, 'INVALID_CHANNELS');
  assert.deepEqual(unknownChannel.body.error.details.channelIds, ['missing']);

  const disconnected = await fixture.json('/api/channels/tiktok', {
    method: 'PATCH',
    body: { connected: false },
  });
  assert.equal(disconnected.response.status, 200);
  assert.equal(disconnected.body.channel.connected, false);
  const disconnectedProject = await fixture.json('/api/projects', {
    method: 'POST',
    body: { title: '연결 필요', channelIds: ['tiktok'] },
  });
  assert.equal(disconnectedProject.response.status, 422);
  assert.equal(disconnectedProject.body.error.code, 'INVALID_CHANNELS');

  await fixture.json('/api/channels/tiktok', { method: 'PATCH', body: { connected: true } });
  const created = await fixture.json('/api/projects', {
    method: 'POST',
    body: { title: '여름 음료 만들기', selectedChannelIds: ['youtube', 'instagram'] },
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.project.status, 'queued');
  assert.deepEqual(created.body.project.channelIds, ['youtube', 'instagram']);
  assert.equal(created.body.job.status, 'queued');
  assert.equal(created.body.job.attempts, 0);
  assert.equal(created.body.job.progress, 0);

  const loadedProject = await fixture.json(`/api/projects/${created.body.project.id}`);
  const loadedJob = await fixture.json(`/api/jobs/${created.body.job.id}`);
  assert.equal(loadedProject.body.project.title, '여름 음료 만들기');
  assert.equal(loadedJob.body.job.projectId, created.body.project.id);

  const rows = fixture.store.db.prepare(`
    SELECT p.id AS project_id, j.id AS job_id
    FROM projects p JOIN jobs j ON j.project_id = p.id WHERE p.id = ?
  `).all(created.body.project.id);
  assert.equal(rows.length, 1);
});

test('body boundary and malformed requests return stable JSON errors', async (t) => {
  const fixture = await createFixture(t, { bodyLimit: 80 });

  const tooLarge = await fixture.json('/api/projects', {
    method: 'POST',
    body: { title: 'x'.repeat(120), channelIds: ['youtube'] },
  });
  assert.equal(tooLarge.response.status, 413);
  assert.equal(tooLarge.body.error.code, 'BODY_TOO_LARGE');

  const malformed = await fixture.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"title":',
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error.code, 'INVALID_JSON');

  const wrongType = await fixture.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(wrongType.response.status, 415);
  assert.equal(wrongType.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const missing = await fixture.json('/api/projects/not-present');
  assert.equal(missing.response.status, 404);
  assert.deepEqual(missing.body.error, { code: 'NOT_FOUND', message: 'Project not found.' });
});

test('content and hook endpoints apply search, status, and channel filters', async (t) => {
  const fixture = await createFixture(t);

  const content = await fixture.json('/api/content?search=%EC%BC%80%EC%9D%B4%ED%81%AC&status=testing&channel=youtube');
  assert.equal(content.response.status, 200);
  assert.equal(content.body.content.length, 1);
  assert.equal(content.body.content[0].channelId, 'youtube');
  assert.match(content.body.content[0].title, /케이크/);

  const noContent = await fixture.json('/api/content?status=published');
  assert.deepEqual(noContent.body.content, []);

  const hooks = await fixture.json('/api/hook-tests?status=running&channel=instagram');
  assert.equal(hooks.response.status, 200);
  assert.equal(hooks.body.hookTests.length, 1);
  assert.equal(hooks.body.hookTests[0].channelId, 'instagram');
  assert.equal(hooks.body.hookTests[0].variants.length, 3);
  assert.equal(hooks.body.hookTests[0].variants[0].score, 53);

  const badStatus = await fixture.json('/api/content?status=broken');
  assert.equal(badStatus.response.status, 422);
  assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');
});

test('schedule and template CRUD persists while singleton resources patch safely', async (t) => {
  const fixture = await createFixture(t);
  const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();

  const createdSchedule = await fixture.json('/api/schedules', {
    method: 'POST',
    body: {
      title: '아침 레시피 게시',
      channelId: 'youtube',
      scheduledAt,
      timezone: 'Asia/Seoul',
    },
  });
  assert.equal(createdSchedule.response.status, 201);
  assert.equal(createdSchedule.body.schedule.channelName, 'YouTube Shorts');
  const invalidContentSchedule = await fixture.json('/api/schedules', {
    method: 'POST',
    body: {
      title: '존재하지 않는 콘텐츠',
      contentId: 'missing-content',
      channelId: 'youtube',
      scheduledAt,
    },
  });
  assert.equal(invalidContentSchedule.response.status, 422);
  assert.equal(invalidContentSchedule.body.error.code, 'VALIDATION_ERROR');
  assert.equal(invalidContentSchedule.body.error.details.field, 'contentId');
  const schedules = await fixture.json('/api/schedules');
  assert.equal(schedules.body.schedules.length, 1);
  const deletedSchedule = await fixture.request(`/api/schedules/${createdSchedule.body.schedule.id}`, {
    method: 'DELETE',
  });
  assert.equal(deletedSchedule.response.status, 204);
  const missingSchedule = await fixture.request(`/api/schedules/${createdSchedule.body.schedule.id}`, {
    method: 'DELETE',
  });
  assert.equal(missingSchedule.response.status, 404);

  const createdTemplate = await fixture.json('/api/templates', {
    method: 'POST',
    body: { name: '교육 훅', category: 'education', body: '{주제}를 1분 안에 이해하기' },
  });
  assert.equal(createdTemplate.response.status, 201);
  const templates = await fixture.json('/api/templates');
  assert.equal(templates.body.templates.length, 3);
  const deletedTemplate = await fixture.request(`/api/templates/${createdTemplate.body.template.id}`, {
    method: 'DELETE',
  });
  assert.equal(deletedTemplate.response.status, 204);

  const brand = await fixture.json('/api/brand', {
    method: 'PATCH',
    body: { voice: '짧고 명확한 전문가', primaryColor: '#123abc' },
  });
  assert.equal(brand.body.brand.voice, '짧고 명확한 전문가');
  assert.equal(brand.body.brand.primaryColor, '#123abc');

  const settings = await fixture.json('/api/settings', {
    method: 'PATCH',
    body: { emailNotifications: false, autoSchedule: true },
  });
  assert.equal(settings.body.settings.emailNotifications, false);
  assert.equal(settings.body.settings.autoSchedule, true);

  const plan = await fixture.json('/api/plan', {
    method: 'PATCH',
    body: { usagePercent: 80, projectLimit: 120 },
  });
  assert.equal(plan.body.plan.usagePercent, 80);
  assert.equal(plan.body.plan.projectLimit, 120);

  const channel = await fixture.json('/api/channels/youtube', {
    method: 'PATCH',
    body: { handle: '@new-handle' },
  });
  assert.equal(channel.body.channel.handle, '@new-handle');

  const notifications = await fixture.json('/api/notifications');
  assert.equal(notifications.body.notifications.filter((item) => !item.read).length, 3);
  const read = await fixture.json(`/api/notifications/${notifications.body.notifications[0].id}/read`, {
    method: 'POST',
  });
  assert.equal(read.body.notification.read, true);
  const afterRead = await fixture.json('/api/notifications');
  assert.equal(afterRead.body.notifications.filter((item) => !item.read).length, 2);

  const persistedBrand = await fixture.json('/api/brand');
  const persistedSettings = await fixture.json('/api/settings');
  const persistedPlan = await fixture.json('/api/plan');
  assert.equal(persistedBrand.body.brand.primaryColor, '#123abc');
  assert.equal(persistedSettings.body.settings.autoSchedule, true);
  assert.equal(persistedPlan.body.plan.projectLimit, 120);
});
