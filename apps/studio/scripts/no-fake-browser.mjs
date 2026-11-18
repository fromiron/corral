// After `vite build`: the development-only stand-in for the desktop's browser bridge
// (src/workbench/browser/fakeBrowserBridge.ts) must not be in the production bundle.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER = 'corral-fake-browser-bridge-5c1e';
const dist = new URL('../dist/', import.meta.url).pathname;

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

const found = [];
for await (const path of files(dist)) {
  if (!/\.(?:js|mjs|html|map)$/.test(path)) continue;
  if ((await readFile(path, 'utf8')).includes(MARKER)) found.push(path.slice(dist.length));
}
if (found.length > 0) {
  console.error(`The fake browser bridge is in the production bundle: ${found.join(', ')}`);
  process.exit(1);
}
