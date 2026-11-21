// pnpm builtin:generate — writes the bundled pack manifest and the core module of built-in
// skills and agents from apps/server/resources/builtin.
// pnpm builtin:check — fails when the committed files are stale.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { builtinOutputs, staleBuiltin } from './builtin.ts';

const check = process.argv.includes('--check');
if (check) {
  const stale = staleBuiltin();
  for (const line of stale) console.error(line);
  if (stale.length) {
    console.error('Run `pnpm builtin:generate` and commit the result.');
    process.exit(1);
  }
  console.log('generated built-in files are up to date');
} else {
  const { problems, files } = builtinOutputs();
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  for (const { path, text } of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
