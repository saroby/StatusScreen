import { readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('../', import.meta.url).pathname;
const ignored = new Set(['.git', 'data', 'node_modules', 'test-results', 'playwright-report']);

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (['.js', '.mjs'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function check(path) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', path], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Syntax check terminated by ${signal}: ${relative(root, path)}`));
      else if (code !== 0) reject(new Error(`Syntax check failed: ${relative(root, path)}`));
      else resolve();
    });
  });
}

const files = await collect(root);
for (const file of files) await check(file);
console.log(`Syntax check passed for ${files.length} JavaScript files.`);
