// pnpm lint runs this after Biome: every ratchet rule is checked against its baseline.
// pnpm lint:update (--update) rewrites the baselines to the tree as it is.

import { join } from 'node:path';
import { effects } from './effects.ts';
import { run } from './ratchet.ts';

const result = run([effects], {
  root: join(import.meta.dirname, '..', '..'),
  update: process.argv.includes('--update'),
});
if (result.output) (result.code === 0 ? console.log : console.error)(result.output);
process.exitCode = result.code;
