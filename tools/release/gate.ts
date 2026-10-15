import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateHash, ROOT } from './candidate.ts';
import { type ReleaseEvidence, verifyEvidence } from './policy.ts';

const output = join(ROOT, 'test-results/release');
mkdirSync(output, { recursive: true });
const evidence: ReleaseEvidence = { candidate: candidateHash(), gates: {} };
const commands = [
  ['spec', ['pnpm', 'spec:check']],
  ['traceability', ['node', 'tools/release/traceability.ts']],
  ['dependencies', ['pnpm', 'deps:check']],
  ['contracts', ['pnpm', 'contracts:check']],
  ['lint', ['pnpm', 'lint']],
  ['typecheck', ['pnpm', 'typecheck']],
  ['tests', ['pnpm', 'test']],
  ['release-tests', ['pnpm', 'test:release']],
  ['build', ['pnpm', 'build']],
  ['e2e', ['pnpm', 'test:e2e']],
  [
    'demo-production',
    [
      'pnpm',
      '--filter',
      '@corral/studio',
      'exec',
      'playwright',
      'test',
      'e2e/studio.spec.ts',
      'e2e/accessibility.spec.ts',
      'e2e/demo.spec.ts',
      '--grep-invert',
      'worker preserves',
      '--project',
      'chromium',
      '--project',
      'firefox',
      '--workers=2',
    ],
  ],
  ['performance', ['pnpm', 'test:performance']],
  ['inventory', ['pnpm', 'release:inventory']],
] as const;
for (const [name, [command, ...args]] of commands) {
  console.log(`Release gate: ${name}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      CORRAL_LIVE: '0',
      CORRAL_STATIC_DEMO: name === 'demo-production' ? '1' : '0',
    },
  });
  evidence.gates[name] = {
    status: result.status === 0 ? 'passed' : 'failed',
    completedAt: new Date().toISOString(),
  };
  writeFileSync(join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
verifyEvidence(evidence, candidateHash(), false);
console.log(
  'Deterministic release gates passed. Release readiness still requires separate current live smoke proof: pnpm release:check tests/live/.last-run.json',
);
