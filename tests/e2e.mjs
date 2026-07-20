import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(new URL('..', import.meta.url).pathname);
const outputDirectory = join(root, 'test-results');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForService(url, processOutput, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // The three local processes may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Service did not become ready at ${url}.\n${processOutput.join('')}`);
}

async function api(base, path, options = {}) {
  const response = await fetch(`${base}/api/${path}`, {
    ...options,
    headers: options.body === undefined
      ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  assert.ok(response.ok, `${options.method || 'GET'} ${path} failed: ${response.status} ${text}`);
  return body;
}

async function route(page, name, heading) {
  await page.evaluate((hash) => { location.hash = hash; }, `#${name}`);
  await page.locator('#app-view h1').filter({ hasText: heading }).waitFor();
}

const tempDirectory = await mkdtemp(join(tmpdir(), 'shortify-e2e-'));
const backendPort = await freePort();
const frontendPort = await freePort();
const base = `http://127.0.0.1:${frontendPort}`;
const processOutput = [];
let browser;
let service;

try {
  await mkdir(outputDirectory, { recursive: true });
  service = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(backendPort),
      FRONTEND_HOST: '127.0.0.1',
      FRONTEND_PORT: String(frontendPort),
      BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      STATUSSCREEN_DB: join(tempDirectory, 'e2e.db'),
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout.on('data', (chunk) => processOutput.push(chunk.toString()));
  service.stderr.on('data', (chunk) => processOutput.push(chunk.toString()));
  const health = await waitForService(`${base}/api/health`, processOutput);
  assert.equal(health.status, 'ok');
  assert.equal(health.database.status, 'ok');
  assert.equal(health.worker.status, 'online');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(base)) runtimeErrors.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`);
  });
  page.on('response', (response) => {
    if (response.url().startsWith(base) && response.status() >= 400) runtimeErrors.push(`response: ${response.status()} ${response.url()}`);
  });

  await page.goto(`${base}/#calendar`, { waitUntil: 'networkidle' });
  await page.locator('#app-view h1').filter({ hasText: '캘린더' }).waitFor();
  assert.equal(await page.locator('[data-schedule-form] select[name="channelId"] option').count(), 4);
  await page.goto(`${base}/#channels`, { waitUntil: 'networkidle' });
  await page.locator('#app-view h1').filter({ hasText: '채널' }).waitFor();
  assert.equal(await page.locator('.channel-card').count(), 3);

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('h1').filter({ hasText: '통합 제작 허브' }).waitFor();
  assert.equal(await page.locator('.channel-card').count(), 3);

  const notificationsBefore = Number(await page.locator('[data-notification-count]').textContent());
  await page.locator('[data-notifications-toggle]').click();
  const readButton = page.locator('[data-read-notification]').first();
  await readButton.waitFor();
  await readButton.click();
  await page.waitForFunction(
    (before) => Number(document.querySelector('[data-notification-count]')?.textContent || 0) === before - 1,
    notificationsBefore,
  );
  await page.locator('[data-notifications-close]').click();

  await page.locator('[data-open-project]').first().click();
  await page.locator('[data-project-dialog][open]').waitFor();
  await page.locator('[data-project-form] input[name="title"]').fill('E2E 여름 음료');
  const createResponse = page.waitForResponse((response) => response.url().endsWith('/api/projects') && response.request().method() === 'POST');
  await page.locator('[data-project-submit]').click();
  assert.equal((await createResponse).status(), 202);
  await page.locator('[data-job-status]').waitFor({ state: 'visible' });
  await page.locator('[data-job-status]').waitFor({ state: 'hidden', timeout: 15_000 });

  await route(page, 'content', '콘텐츠');
  await page.locator('text=E2E 여름 음료').first().waitFor();
  await page.locator('[data-content-filters] input[name="q"]').fill('E2E 여름');
  await page.locator('[data-content-filters] button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.data-table tbody tr').length === 3);
  assert.equal(await page.locator('.data-table tbody tr').count(), 3);

  await route(page, 'hook-tests', '훅 테스트');
  assert.equal(await page.locator('.hook-row', { hasText: 'E2E 여름 음료' }).count(), 3);

  await route(page, 'calendar', '캘린더');
  await page.locator('[data-toggle-schedule-form]').first().click();
  const scheduleForm = page.locator('[data-schedule-form]');
  await scheduleForm.locator('input[name="title"]').fill('E2E 게시 일정');
  await scheduleForm.locator('input[name="scheduledAt"]').fill('2030-01-02T10:30');
  await scheduleForm.locator('select[name="channelId"]').selectOption('youtube');
  await scheduleForm.locator('button[type="submit"]').click();
  const scheduleCard = page.locator('.schedule-card', { hasText: 'E2E 게시 일정' });
  await scheduleCard.waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await scheduleCard.locator('[data-delete-schedule]').click();
  await scheduleCard.waitFor({ state: 'detached' });
  await page.locator('#app-view h1').filter({ hasText: '캘린더' }).waitFor();

  await route(page, 'analytics', '분석');
  await page.locator('[data-analytics-range]').selectOption('30');
  await page.locator('.metric-tile').filter({ hasText: '1124만' }).waitFor();
  assert.equal(await page.locator('.bar-row').count(), 3);

  await route(page, 'channels', '채널');
  assert.equal(await page.locator('.channel-card').count(), 3);
  const youtubeCard = page.locator('.channel-card', { hasText: 'YouTube Shorts' });
  page.once('dialog', (dialog) => dialog.accept());
  await youtubeCard.locator('[data-channel-toggle]').click();
  await youtubeCard.locator('[data-channel-toggle]', { hasText: '연결' }).waitFor();
  assert.equal((await api(base, 'channels')).channels.find((channel) => channel.id === 'youtube').connected, false);
  await youtubeCard.locator('[data-channel-toggle]').click();
  await youtubeCard.locator('[data-channel-toggle]', { hasText: '연결 해제' }).waitFor();

  await route(page, 'templates', '템플릿');
  await page.locator('[data-toggle-template-form]').first().click();
  const templateForm = page.locator('[data-template-form]');
  await templateForm.locator('input[name="name"]').fill('E2E 템플릿');
  await templateForm.locator('input[name="category"]').fill('검증');
  await templateForm.locator('input[name="body"]').fill('시작, 핵심, 행동 유도 순서로 구성');
  await templateForm.locator('button[type="submit"]').click();
  const templateCard = page.locator('.template-card', { hasText: 'E2E 템플릿' });
  await templateCard.waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await templateCard.locator('[data-delete-template]').click();
  await templateCard.waitFor({ state: 'detached' });
  await page.locator('#app-view h1').filter({ hasText: '템플릿' }).waitFor();

  await route(page, 'brand', '브랜드');
  const originalBrand = (await api(base, 'brand')).brand;
  const brandForm = page.locator('[data-brand-form]');
  await brandForm.locator('input[name="name"]').fill('E2E 브랜드');
  await brandForm.locator('input[name="logoUrl"]').fill('');
  await brandForm.locator('button[type="submit"]').click();
  await page.locator('.toast.success', { hasText: '브랜드 설정을 저장했습니다.' }).waitFor();
  const updatedBrand = (await api(base, 'brand')).brand;
  assert.equal(updatedBrand.name, 'E2E 브랜드');
  assert.equal(updatedBrand.logoUrl, null);
  await api(base, 'brand', { method: 'PATCH', body: originalBrand });

  await route(page, 'settings', '설정');
  const originalSettings = (await api(base, 'settings')).settings;
  const settingsForm = page.locator('[data-settings-form]');
  await settingsForm.locator('select[name="locale"]').selectOption('en-US');
  await settingsForm.locator('select[name="timezone"]').selectOption('UTC');
  await settingsForm.locator('button[type="submit"]').click();
  await page.locator('.toast.success', { hasText: '설정을 저장했습니다.' }).waitFor();
  assert.equal((await api(base, 'settings')).settings.timezone, 'UTC');
  await api(base, 'settings', { method: 'PATCH', body: originalSettings });

  await route(page, 'plan', '플랜 관리');
  const originalPlan = (await api(base, 'plan')).plan;
  const planForm = page.locator('[data-plan-form]');
  await planForm.locator('input[name="name"]').fill('E2E 플랜');
  await planForm.locator('input[name="usagePercent"]').fill('44');
  await planForm.locator('button[type="submit"]').click();
  await page.locator('.toast.success', { hasText: '플랜을 변경했습니다.' }).waitFor();
  assert.equal((await api(base, 'plan')).plan.usagePercent, 44);
  await api(base, 'plan', { method: 'PATCH', body: originalPlan });

  await route(page, 'dashboard', '통합 제작 허브');
  await page.waitForFunction(() => document.querySelectorAll('[data-toast-region] .toast').length === 0);
  await page.screenshot({ path: join(outputDirectory, 'e2e-desktop.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('h1').filter({ hasText: '통합 제작 허브' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.locator('[data-menu-toggle]').click();
  await page.locator('body.menu-open').waitFor();
  await page.locator('[data-menu-close]').click();
  assert.equal(await page.locator('body.menu-open').count(), 0);
  await page.screenshot({ path: join(outputDirectory, 'e2e-mobile.png'), fullPage: true });

  assert.deepEqual(runtimeErrors, [], `Browser runtime errors:\n${runtimeErrors.join('\n')}`);
  console.log('E2E passed: 10 views, async project worker, CRUD, settings, and mobile navigation.');
  console.log(`Screenshots: ${join(outputDirectory, 'e2e-desktop.png')}, ${join(outputDirectory, 'e2e-mobile.png')}`);
} finally {
  await browser?.close();
  if (service && service.exitCode === null) {
    service.kill('SIGTERM');
    await Promise.race([once(service, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))]);
    if (service.exitCode === null) service.kill('SIGKILL');
  }
  await rm(tempDirectory, { recursive: true, force: true });
}
