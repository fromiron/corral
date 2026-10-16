import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EffortQuestion } from '@corral/contracts';
import { DecisionAnswer } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { defaultModelDir, installState, OnnxEffortProvider } from '../src/index.ts';

// Opt-in: the real model (≈185 MB) is never downloaded in CI (AGENTS rule 4).
//   pnpm corral judge install && CORRAL_EFFORT_MODEL=1 pnpm exec vitest run --project effort-judge
const live = process.env.CORRAL_EFFORT_MODEL === '1';

const ask = (excerpt: string): EffortQuestion => ({
  questionKind: 'reasoning_effort',
  questionVersion: 1,
  candidates: ['low', 'medium', 'high', 'xhigh'],
  subject: { runId: 'r', executionId: 'e', attemptNo: 1, modelCallId: 'c', contextSnapshotId: 'x' },
  input: {
    features: {
      outputContract: 'text',
      assignment: 'scheduled',
      round: null,
      lastReviewVerdict: null,
      inputArtifacts: 0,
      inputChars: excerpt.length,
      directives: 0,
      requestNo: 1,
      recentTools: [],
    },
    excerpt,
  },
});

describe.skipIf(!live)('local-model on the installed release (opt-in)', () => {
  it('[TC-DEC-001-N] releases the worker after a real model load fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'corral-judge-missing-'));
    const moduleUrl = new URL('../src/provider.ts', import.meta.url).href;
    try {
      await promisify(execFile)(
        process.execPath,
        [
          '-e',
          `process.exitCode = 2; import(${JSON.stringify(moduleUrl)}).then(({ workerSession }) => workerSession(${JSON.stringify(dir)})).then(() => { process.exitCode = 1; }, error => { process.exitCode = /NO_SUCHFILE|File.*exist/.test(error.message) ? 0 : 3; });`,
        ],
        { timeout: 5_000 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('[TC-DEC-001-H] judges a trivial request lower than a hard design task, in a worker thread', async () => {
    const dir = defaultModelDir();
    expect(installState(dir)).toBe('current');
    const provider = new OnnxEffortProvider({ dir });
    expect(provider.available()).toBe(true);
    const never = { aborted: false, onCancel: () => () => {} };
    const easy = DecisionAnswer.parse(await provider.decide(ask('Say hi.'), never));
    const hard = DecisionAnswer.parse(
      await provider.decide(
        ask(
          'Design a distributed, crash-consistent job scheduler with exactly-once side effects across regions, prove its invariants and migrate the existing 40 services without downtime.',
        ),
        never,
      ),
    );
    const order = ['low', 'medium', 'high', 'xhigh'];
    expect(order.indexOf(hard.answer)).toBeGreaterThan(order.indexOf(easy.answer));
    await provider.close();
  }, 30_000);
});
