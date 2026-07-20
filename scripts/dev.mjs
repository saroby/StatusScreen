import { spawn } from 'node:child_process';

const processes = [
  ['backend', ['backend/server.mjs']],
  ['worker', ['worker/worker.mjs']],
  ['frontend', ['scripts/frontend-server.mjs']],
];
let stopping = false;

const children = processes.map(([name, args]) => {
  const child = spawn(process.execPath, args, {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.once('error', (error) => {
    console.error(`[${name}] failed to start`, error);
    shutdown(1);
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[${name}] exited unexpectedly (${signal || code})`);
      shutdown(code || 1);
    }
  });
  return child;
});

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  const forceTimer = setTimeout(() => {
    for (const child of children) if (!child.killed) child.kill('SIGKILL');
    process.exit(code);
  }, 5_000);
  forceTimer.unref();
  Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', resolve);
  }))).then(() => process.exit(code));
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
