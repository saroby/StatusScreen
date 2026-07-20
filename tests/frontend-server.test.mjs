import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

test('frontend server serves the SPA and rejects unsupported methods', async () => {
  process.env.BACKEND_URL = 'http://127.0.0.1:1';
  const { createFrontendServer } = await import('../scripts/frontend-server.mjs');
  const server = createFrontendServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/content`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(await page.text(), /Shortify Hub/);

    const response = await fetch(`${base}/not-an-api`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('frontend server returns an actionable error when the backend is unavailable', async () => {
  const { createFrontendServer } = await import('../scripts/frontend-server.mjs');
  const server = createFrontendServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'BACKEND_UNAVAILABLE');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
