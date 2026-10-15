import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffortQuestion } from '@corral/contracts';
import { DecisionAnswer } from '@corral/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseLevel, OnnxEffortProvider } from '../src/index.ts';

const dirs: string[] = [];
function installed(calibration = { temperature: 1, inputFormat: 'pr', maxTokens: 16 }) {
  const dir = mkdtempSync(join(tmpdir(), 'corral-judge-'));
  cpSync(join(import.meta.dirname, 'fixtures', 'tiny'), dir, { recursive: true });
  writeFileSync(join(dir, 'calibration.json'), JSON.stringify(calibration));
  writeFileSync(join(dir, 'model.onnx'), 'not a real model');
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ release: 'effort-judge-v6' }));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const question = (excerpt = 'ab ab'): EffortQuestion => ({
  questionKind: 'reasoning_effort',
  questionVersion: 1,
  candidates: ['low', 'medium', 'high', 'xhigh'],
  subject: { runId: 'r', executionId: 'e', attemptNo: 1, modelCallId: 'c', contextSnapshotId: 'x' },
  input: {
    features: {
      outputContract: 'draft',
      assignment: 'scheduled',
      round: null,
      lastReviewVerdict: null,
      inputArtifacts: 0,
      inputChars: 5,
      directives: 0,
      requestNo: 1,
      recentTools: [],
    },
    excerpt,
  },
});
const never = { aborted: false, onCancel: () => () => {} };

describe('local-model provider (C-072)', () => {
  it('[TC-DEC-001-H] turns calibrated logits into probabilities and picks the level by expected cost', async () => {
    const seen: number[][] = [];
    const provider = new OnnxEffortProvider({
      dir: installed(),
      release: 'effort-judge-v6',
      session: async () => ({
        run: async (ids) => {
          seen.push(ids);
          return [0, 2, 1, -1];
        },
      }),
    });
    expect(provider.id).toBe('local-model');
    expect(provider.version).toBe('effort-judge-v6');
    expect(provider.privacy).toBe('local');
    expect(provider.available()).toBe(true);
    const answer = DecisionAnswer.parse(await provider.decide(question(), never));
    expect(answer.evidenceLevel).toBe('model_probability');
    expect(answer.answer).toBe('medium');
    const p = answer.probabilities;
    expect(p && p.medium > p.high && p.high > p.low && p.low > p.xhigh).toBe(true);
    // <bos> … <eos> around the encoded "previous reply: … request: …" text.
    expect(seen[0]?.[0]).toBe(1);
    expect(seen[0]?.at(-1)).toBe(2);
    expect(seen[0]?.length).toBeLessThanOrEqual(16);
  });

  it('[TC-DEC-001-N] an under-call costs more than an over-call', () => {
    // Even odds between easy and hard: never answer easy.
    expect(chooseLevel([0.5, 0, 0.5, 0])).not.toBe(0);
    expect(chooseLevel([0.97, 0.02, 0.01, 0])).toBe(0);
    expect(chooseLevel([0, 0, 0.1, 0.9])).toBe(3);
  });

  it('[TC-DEC-001-N] not installed, a stale release or an unsupported platform is unavailable with a reason', () => {
    const missing = new OnnxEffortProvider({
      dir: join(tmpdir(), 'corral-judge-none'),
      release: 'effort-judge-v6',
    });
    expect(missing.available()).toMatch(/not installed/);
    const stale = new OnnxEffortProvider({ dir: installed(), release: 'effort-judge-v7' });
    expect(stale.available()).toMatch(/older release/);
    const mac = new OnnxEffortProvider({
      dir: installed(),
      release: 'effort-judge-v6',
      platform: { platform: 'darwin', arch: 'x64' },
    });
    expect(mac.available()).toMatch(/no onnxruntime build/);
  });

  it('[TC-DEC-001-N] a session that fails to load or run rejects, so the judgment fails as provider_error', async () => {
    const provider = new OnnxEffortProvider({
      dir: installed(),
      release: 'effort-judge-v6',
      session: async () => {
        throw new Error('bad model');
      },
    });
    await expect(provider.decide(question(), never)).rejects.toThrow('bad model');
  });
});
