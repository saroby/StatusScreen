import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = resolve(fileURLToPath(new URL('../frontend/', import.meta.url)));
const backendUrl = new URL(process.env.BACKEND_URL || 'http://127.0.0.1:3000');
const host = process.env.FRONTEND_HOST || '127.0.0.1';
const port = Number(process.env.FRONTEND_PORT || 8080);
const maxProxyBody = 1_048_576;
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxProxyBody) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function proxy(request, response) {
  const target = new URL(request.url, backendUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await readBody(request);
    const upstream = await fetch(target, {
      method: request.method,
      body,
      headers: {
        accept: request.headers.accept || 'application/json',
        'content-type': request.headers['content-type'] || 'application/json',
        'x-request-id': request.headers['x-request-id'] || crypto.randomUUID(),
      },
      signal: controller.signal,
    });
    const payload = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'content-length': payload.length,
      'cache-control': 'no-store',
      'x-request-id': upstream.headers.get('x-request-id') || '',
    });
    response.end(payload);
  } catch (error) {
    const status = error.status || 502;
    sendJson(response, status, { error: { code: status === 413 ? 'BODY_TOO_LARGE' : 'BACKEND_UNAVAILABLE', message: status === 413 ? error.message : 'Backend service is unavailable.' } });
  } finally {
    clearTimeout(timer);
  }
}

async function staticFile(request, response) {
  const url = new URL(request.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(response, 400, { error: { code: 'INVALID_PATH', message: 'The request path is invalid.' } });
    return;
  }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let path = normalize(join(frontendRoot, requested));
  if (relative(frontendRoot, path).startsWith('..')) {
    sendJson(response, 403, { error: { code: 'FORBIDDEN', message: 'The requested path is not allowed.' } });
    return;
  }
  try {
    await access(path);
    if (!(await stat(path)).isFile()) throw new Error('Not a file');
  } catch {
    path = join(frontendRoot, 'index.html');
  }
  const details = await stat(path);
  response.writeHead(200, {
    'content-type': mimeTypes.get(extname(path)) || 'application/octet-stream',
    'content-length': details.size,
    'cache-control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(path).pipe(response);
}

export function createFrontendServer() {
  return createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/api/')) await proxy(request, response);
      else if (['GET', 'HEAD'].includes(request.method)) await staticFile(request, response);
      else sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
    } catch (error) {
      console.error('Frontend server error', error);
      if (!response.headersSent) sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Unable to serve the request.' } });
      else response.destroy();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createFrontendServer();
  server.listen(port, host, () => console.log(`Shortify frontend listening on http://${host}:${port}`));
  const shutdown = () => server.close((error) => {
    if (error) console.error(error);
    process.exit(error ? 1 : 0);
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
