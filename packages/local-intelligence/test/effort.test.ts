import type { DecisionCancellation, ReasoningInput } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { type EffortWeights, loadEffortClassifier } from '../src/effort/classifier.ts';
import { EFFORT_PREPROCESS_VERSION, effortText } from '../src/effort/preprocess.ts';
import { LocalEffortProvider } from '../src/effort/provider.ts';
import type { EmbedRequest } from '../src/engine/engine.ts';

const input = (overrides: Partial<ReasoningInput> = {}): ReasoningInput => ({
  kind: 'turn',
  request: 'Fix the flaky reconnect test',
  prevRequest: '',
  prev: '',
  step: 0,
  plan: '',
  calls: [],
  directiveIds: [],
  ...overrides,
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('effort preprocessing', () => {
  it('puts the current request first, then plan, recent calls and earlier turns', () => {
    const text = effortText(
      input({
        kind: 'step',
        request: 'Fix the flaky reconnect test',
        prevRequest: 'run the tests',
        prev: '1 failed, 41 passed',
        plan: 'reproduce, then fix',
        calls: [
          { name: 'read_file', args: '{"path":"a.ts"}', result: 'old' },
          { name: 'run', args: '{"cmd":"vitest"}', result: 'FAIL socket.test.ts' },
        ],
      }),
    );
    expect(text.split('\n')).toEqual([
      'request: Fix the flaky reconnect test',
      'plan: reproduce, then fix',
      'call: run {"cmd":"vitest"}',
      'result: FAIL socket.test.ts',
      'call: read_file {"path":"a.ts"}',
      'result: old',
      'previous request: run the tests',
      'previous reply: 1 failed, 41 passed',
    ]);
  });

  it('caps each part, strips terminal escapes and leaves the input untouched', () => {
    const original = input({
      request: `\u001b[31mred\u001b[0m ${'가'.repeat(5000)}`,
      prev: `${'x'.repeat(2000)}END`,
      calls: [{ name: 'run', args: 'a'.repeat(400), result: `${'h'.repeat(3000)}TAIL` }],
    });
    const frozen = deepFreeze(structuredClone(original));
    const text = effortText(frozen);
    expect(frozen).toEqual(original);
    const [request, call, result, previous] = text.split('\n');
    expect(request!.startsWith('request: red 가')).toBe(true);
    expect([...request!].length).toBeLessThanOrEqual('request: '.length + 1200);
    expect([...call!].length).toBeLessThanOrEqual('call: run '.length + 160);
    expect(result!.endsWith('TAIL')).toBe(true);
    expect(previous!.endsWith('END')).toBe(true);
    expect(text).not.toContain('\u001b');
    expect(EFFORT_PREPROCESS_VERSION).toBe('effort-text-v1');
  });
});

function weights(overrides: Partial<EffortWeights> = {}): EffortWeights {
  // Each level reads one dimension; temperature 1.
  return {
    schemaVersion: 1,
    version: 'effort-test',
    labels: ['low', 'medium', 'high', 'xhigh'],
    dims: 4,
    baseModelSha256: 'a'.repeat(64),
    preprocessVersion: EFFORT_PREPROCESS_VERSION,
    task: 'classification',
    weights: [
      [4, 0, 0, 0],
      [0, 4, 0, 0],
      [0, 0, 4, 0],
      [0, 0, 0, 4],
    ],
    bias: [0, 0, 0, 0],
    temperature: 1,
    abstainBelow: 0.5,
    ...overrides,
  };
}
const expected = {
  dims: 4,
  baseModelSha256: 'a'.repeat(64),
  preprocessVersion: EFFORT_PREPROCESS_VERSION,
};

describe('effort classifier', () => {
  it('returns calibrated probabilities and abstains below the bundled threshold', () => {
    const classifier = loadEffortClassifier(weights(), expected);
    const clear = classifier.judge(Float32Array.from([0, 0, 1, 0]));
    expect(clear.answer).toBe('high');
    expect(clear.abstain).toBe(false);
    const sum = Object.values(clear.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    const unclear = classifier.judge(Float32Array.from([0.1, 0.1, 0.12, 0.1]));
    expect(unclear.abstain).toBe(true);
    const hotter = loadEffortClassifier(weights({ temperature: 4 }), expected);
    expect(hotter.judge(Float32Array.from([0, 0, 1, 0])).probabilities.high).toBeLessThan(
      clear.probabilities.high,
    );
  });

  it('refuses weights trained for another model, size or preprocessing', () => {
    expect(() => loadEffortClassifier(weights(), { ...expected, dims: 768 })).toThrow(/dimensions/);
    expect(() =>
      loadEffortClassifier(weights(), { ...expected, baseModelSha256: 'b'.repeat(64) }),
    ).toThrow(/model/);
    expect(() =>
      loadEffortClassifier(weights({ preprocessVersion: 'effort-text-v0' }), expected),
    ).toThrow(/preprocess/);
    expect(() =>
      loadEffortClassifier(weights({ labels: ['medium', 'low', 'high', 'xhigh'] }), expected),
    ).toThrow(/labels/);
    expect(() => loadEffortClassifier(weights({ weights: [[1, 2]] }), expected)).toThrow();
    expect(() => loadEffortClassifier(weights({ temperature: 0 }), expected)).toThrow();
    const classifier = loadEffortClassifier(weights(), expected);
    expect(() => classifier.judge(Float32Array.from([1, 2]))).toThrow(/dimensions/);
  });
});

describe('local effort provider', () => {
  function provider(vector: number[], available: true | string = true) {
    const requests: EmbedRequest[] = [];
    const signals: (DecisionCancellation | undefined)[] = [];
    const engine = {
      available: () => available,
      isReady: () => true,
      warmUp: async () => {},
      embed: async (request: EmbedRequest, cancellation?: DecisionCancellation) => {
        requests.push(request);
        signals.push(cancellation);
        return [Float32Array.from(vector)];
      },
    };
    const judge = new LocalEffortProvider({
      engine,
      classifier: loadEffortClassifier(weights(), expected),
      release: 'bundle-1',
    });
    return { judge, requests, signals };
  }
  const cancellation: DecisionCancellation = { aborted: false, onCancel: () => () => {} };

  it('judges a full request input as a truncated classification embedding', async () => {
    const { judge, requests, signals } = provider([0, 0, 0, 1]);
    expect(judge.id).toBe('local-model');
    expect(judge.privacy).toBe('local');
    expect(judge.version).toBe('bundle-1+effort-test');
    const answer = await judge.decideRequest(input(), cancellation);
    expect(answer).toMatchObject({
      answer: 'xhigh',
      abstain: false,
      evidenceLevel: 'model_probability',
    });
    expect(requests[0]).toEqual({
      texts: [effortText(input())],
      task: 'classification',
      overflow: 'truncate',
      priority: 'effort',
    });
    expect(signals[0]).toBe(cancellation);
  });

  it('reports an unclear judgment as abstained', async () => {
    const { judge } = provider([0.1, 0.1, 0.1, 0.1]);
    expect(await judge.decideRequest(input(), cancellation)).toMatchObject({ abstain: true });
  });

  it('judges the observer excerpt on the observe path and never judges compaction', async () => {
    const { judge, requests } = provider([1, 0, 0, 0]);
    const observed = await judge.decide(
      {
        questionKind: 'reasoning_effort',
        questionVersion: 1,
        candidates: ['low', 'medium', 'high', 'xhigh'],
        subject: {
          runId: 'run_1',
          executionId: 'exe_1',
          attemptNo: 1,
          modelCallId: 'call_1',
          contextSnapshotId: 'ctx_1',
        },
        input: { excerpt: 'thanks', features: {} },
      } as never,
      cancellation,
    );
    expect(observed).toMatchObject({ answer: 'low' });
    expect(requests[0]!.texts).toEqual(['request: thanks']);
    await expect(judge.decideRequest(input({ kind: 'compaction' }), cancellation)).rejects.toThrow(
      /compaction/,
    );
  });

  it('passes on why the engine cannot answer', () => {
    expect(provider([0, 0, 0, 1], 'not installed').judge.available()).toBe('not installed');
  });
});
