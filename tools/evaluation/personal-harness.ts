import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runHarnessComparison } from '../../packages/cli/test/fixtures/personal-harness.ts';

const output = process.argv[2];
if (!output || process.argv.length !== 3)
  throw new Error('Usage: node tools/evaluation/personal-harness.ts <report.json>');
const root = resolve(import.meta.dirname, '../..');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const workingTreeDirty =
  execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
const result = await runHarnessComparison();
writeFileSync(
  resolve(output),
  JSON.stringify(
    { sourceCommit, workingTreeDirty, recordedAt: new Date().toISOString(), ...result },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  `Saved ${result.report.results.length} local SDK fixture runs; ${result.evidence.completedChecks} completed checks.\n`,
);
