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

  it('[TC-DEC-001-H] allows for loading the model on the first judgment, then holds judgments to 1.5 s', async () => {
    let finishLoad!: () => void;
    const loading = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    const provider = new OnnxEffortProvider({
      dir: installed(),
      release: 'effort-judge-v6',
      session: async () => {
        await loading;
        return { run: async () => [0, 2, 1, -1] };
      },
    });
    // Not loaded yet: a judgment may wait for the load (observe only, nothing waits on it).
    expect(provider.timeoutMs).toBe(20_000);
    const warming = provider.warmUp();
    expect(provider.timeoutMs).toBe(20_000);
    finishLoad();
    await warming;
    expect(provider.timeoutMs).toBe(1_500);
  });

  it('[TC-DEC-001-N] a failed load goes back to allowing for the next load', async () => {
    const provider = new OnnxEffortProvider({
      dir: installed(),
      release: 'effort-judge-v6',
      session: async () => {
        throw new Error('no runtime');
      },
    });
    await expect(provider.warmUp()).rejects.toThrow('no runtime');
    await Promise.resolve();
    expect(provider.timeoutMs).toBe(20_000);
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

it('[TC-RSN-002-H] sends a v6 tool step through the step formatter', async () => {
  const dir = installed();
  writeFileSync(
    join(dir, 'calibration.json'),
    JSON.stringify({ temperature: 1, inputFormat: 'rp', maxTokens: 256, steps: 1 }),
  );
  const seen: number[][] = [];
  const provider = new OnnxEffortProvider({
    dir,
    session: async () => ({
      run: async (ids) => {
        seen.push(ids);
        return [0, 0, 5, 0];
      },
    }),
  });
  const input = {
    kind: 'step' as const,
    request: 'ab',
    prevRequest: '',
    prev: '',
    step: 1,
    plan: 'ab',
    calls: [{ name: 'read', args: '{}', result: 'ab ab' }],
    directiveIds: [],
  };
  const answer = await provider.decideRequest(input, never);
  expect(DecisionAnswer.parse(answer).answer).toBe('high');
  expect(seen).toHaveLength(1);
  expect(seen[0]!.length).toBeLessThanOrEqual(256);
  await provider.close();
});

it('[TC-RSN-002-N] a timed-out inference keeps its slot until the real work ends', async () => {
  const { vi } = await import('vitest');
  vi.useFakeTimers();
  let finish!: (value: number[]) => void;
  let running = 0,
    peak = 0;
  const provider = new OnnxEffortProvider({
    dir: installed(),
    session: async () => ({
      run: async () => {
        peak = Math.max(peak, ++running);
        const value = await new Promise<number[]>((resolve) => {
          finish = resolve;
        });
        running--;
        return value;
      },
    }),
  });
  const input = {
    kind: 'turn' as const,
    request: 'ab',
    prev: '',
    prevRequest: '',
    step: 0,
    plan: '',
    calls: [],
    directiveIds: [],
  };
  try {
    await provider.warmUp();
    const first = provider.decideRequest(input, never).catch((error: Error) => error.cause);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await first).toBe('timeout');
    const waiting = [0, 1, 2].map(() =>
      provider.decideRequest(input, never).catch((error: Error) => error.cause),
    );
    await expect(provider.decideRequest(input, never)).rejects.toThrow('queue full');
    expect(running).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await Promise.all(waiting)).toEqual(['timeout', 'timeout', 'timeout']);
    finish([0, 1, 0, 0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(1);
    expect(running).toBe(0);
    await provider.close();
  } finally {
    vi.useRealTimers();
  }
});
