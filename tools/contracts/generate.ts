// pnpm contracts:generate — writes JSON Schema generated from the Zod source (C-005).
// pnpm contracts:check — fails when the committed files are stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateJsonSchemas } from '../../packages/contracts/src/json-schema.ts';

const OUT = join(import.meta.dirname, '..', '..', 'packages', 'contracts', 'generated');
const check = process.argv.includes('--check');
let stale = 0;

for (const [file, schema] of Object.entries(generateJsonSchemas())) {
  const path = join(OUT, file);
  const text = `${JSON.stringify(schema, null, 2)}\n`;
  if (!check) {
    writeFileSync(path, text);
    continue;
  }
  let current = '';
  try {
    current = readFileSync(path, 'utf-8');
  } catch {}
  if (current !== text) {
    stale += 1;
    console.error(`stale: packages/contracts/generated/${file}`);
  }
}

if (check && stale > 0) {
  console.error('Run `pnpm contracts:generate` and commit the result.');
  process.exit(1);
}
console.log(check ? 'generated JSON Schema is up to date' : `wrote ${OUT}`);
