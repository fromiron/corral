import type { DecisionCancellation, ReasoningInput } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { type EffortWeights, loadEffortClassifier } from '../src/effort/classifier.ts';
import { EFFORT_PREPROCESS_VERSION, effortText, requestInput } from '../src/effort/preprocess.ts';
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
  it('writes the judge text fields in order, with tool calls as supplied', () => {
    const text = effortText(
      input({
        kind: 'step',
        request: 'Fix the flaky reconnect test',
        prevRequest: 'run the tests',
        prev: '1 failed, 41 passed',
        plan: 'reproduce, then fix',
        calls: [
          { name: 'read_file', args: '{"path":"a.ts"}', result: 'old' },
          {
            name: 'run',
            args: '{"cmd":"vitest"}',
            result: 'FAIL socket.test.ts',
            status: 'failed',
          },
          { name: 'list', args: '', result: '' },
        ],
      }),
    );
    expect(text.split('\n')).toEqual([
      'Task: choose the minimum reasoning effort for the NEXT coding response.',
      'Stage: step',
      'Current request: Fix the flaky reconnect test',
      'Previous user request: run the tests',
      'Previous reply: 1 failed, 41 passed',
      'Current plan: reproduce, then fix',
      'Tool 1: read_file; status: completed',
      'Arguments: {"path":"a.ts"}',
      'Observed output: old',
      'Tool 2: run; status: failed',
      'Arguments: {"cmd":"vitest"}',
      'Observed output: FAIL socket.test.ts',
      'Tool 3: list; status: completed',
      'Observed output: ',
    ]);
    expect(EFFORT_PREPROCESS_VERSION).toBe('effort-text-v2');
  });

  it('leaves empty parts out, clips nothing and leaves the input untouched', () => {
    const long = `start ${'가'.repeat(5000)} end`;
    const original = input({ request: long, prev: '', plan: '' });
    const frozen = deepFreeze(structuredClone(original));
    const text = effortText(frozen);
    expect(frozen).toEqual(original);
    // The engine cuts at the model's token limit, keeping the start, so nothing is cut here.
    expect(text.split('\n')).toEqual([
      'Task: choose the minimum reasoning effort for the NEXT coding response.',
      'Stage: turn',
      `Current request: ${long}`,
    ]);
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

// A two-head v3 fixture: LayerNorm, GELU hidden layer and output for the level, logistic openness.
// Expected values come from an independent numpy computation of the same weights.
const v3 = {
  schemaVersion: 3,
  version: 'effort-v3-test',
  labels: ['low', 'medium', 'high', 'xhigh'],
  dims: 4,
  baseModelSha256: 'a'.repeat(64),
  preprocessVersion: EFFORT_PREPROCESS_VERSION,
  task: 'classification',
  layerNorm: { weight: [1, 0.5, 2, 1], bias: [0, 0.1, -0.1, 0], eps: 1e-5 },
  hidden: {
    weights: [
      [1, -1, 0.5, 0],
      [0, 0.5, -1, 1],
    ],
    bias: [0.1, -0.2],
    activation: 'gelu',
  },
  weights: [
    [1, 0],
    [0, 1],
    [-1, 1],
    [0.5, -0.5],
  ],
  bias: [0, 0, 0, 0],
  temperature: 1,
  abstainBelow: 0,
  open: { weights: [2, 0, 0, -2], bias: -0.5, raiseAt: 0.55 },
};

describe('effort classifier v3: level and openness heads', () => {
  it('raises an open request to high whatever the level head says', () => {
    const classifier = loadEffortClassifier(v3, expected);
    const judged = classifier.judge(Float32Array.from([0.6, -0.2, 0.3, 0.1]));
    expect(judged.open).toBeCloseTo(0.622459, 5);
    expect(judged.probabilities.low).toBeCloseTo(0.701492, 5);
    expect(judged.probabilities.medium).toBeCloseTo(0.0612, 5);
    expect(judged.probabilities.high).toBeCloseTo(0.005962, 5);
    expect(judged.probabilities.xhigh).toBeCloseTo(0.231346, 5);
    expect(judged.answer).toBe('high');
    expect(judged.abstain).toBe(false);
  });

  it("takes the level head's top answer below the raise threshold and never abstains", () => {
    const classifier = loadEffortClassifier(v3, expected);
    const judged = classifier.judge(Float32Array.from([0.1, -0.2, 0.3, 0.6]));
    expect(judged.open).toBeCloseTo(0.182426, 5);
    expect(judged.probabilities.low).toBeCloseTo(0.340072, 5);
    expect(judged.answer).toBe('low');
    expect(judged.abstain).toBe(false);
    expect(classifier.abstains).toBe(false);
    // Exactly at the threshold counts as open.
    const at = loadEffortClassifier(
      { ...v3, open: { ...v3.open, raiseAt: judged.open! } },
      expected,
    );
    expect(at.judge(Float32Array.from([0.1, -0.2, 0.3, 0.6])).answer).toBe('high');
  });

  it('refuses v3 weights with a missing or mis-sized part', () => {
    const { open: _open, ...noOpen } = v3;
    expect(() => loadEffortClassifier(noOpen, expected)).toThrow();
    expect(() =>
      loadEffortClassifier({ ...v3, open: { ...v3.open, weights: [1, 2, 3] } }, expected),
    ).toThrow();
    expect(() =>
      loadEffortClassifier({ ...v3, open: { ...v3.open, raiseAt: 1.5 } }, expected),
    ).toThrow();
    expect(() =>
      loadEffortClassifier({ ...v3, layerNorm: { ...v3.layerNorm, weight: [1, 1] } }, expected),
    ).toThrow();
    expect(() =>
      loadEffortClassifier({ ...v3, hidden: { ...v3.hidden, activation: 'relu' } }, expected),
    ).toThrow();
    expect(() => loadEffortClassifier({ ...v3, layerNorm: undefined }, expected)).toThrow();
    // Openness belongs to v3; older formats cannot carry it.
    expect(() => loadEffortClassifier({ ...weights(), open: v3.open }, expected)).toThrow();
  });
});

describe('effort classifier', () => {
  it('loads a versioned hidden-layer head over the unchanged embedding', () => {
    const raw = {
      ...weights(),
      schemaVersion: 2,
      hidden: {
        weights: [
          [1, -1, 0, 0],
          [0, 0, 1, -1],
        ],
        bias: [0, 0],
      },
      weights: [
        [4, 0],
        [0, 0],
        [0, 6],
        [0, 0],
      ],
    };
    const classifier = loadEffortClassifier(raw, expected);
    expect(classifier.judge(Float32Array.from([1, 0, 0, 0])).answer).toBe('low');
    expect(classifier.judge(Float32Array.from([0, 0, 1, 0])).answer).toBe('high');
    // ReLU discards the negative hidden unit instead of making its opposite class confident.
    expect(classifier.judge(Float32Array.from([0, 1, 0, 0])).abstain).toBe(true);
    expect(() =>
      loadEffortClassifier({ ...raw, weights: [[1], [2], [3], [4]] }, expected),
    ).toThrow();
    expect(() =>
      loadEffortClassifier({ ...raw, hidden: { ...raw.hidden, bias: [0] } }, expected),
    ).toThrow();
    expect(() =>
      loadEffortClassifier({ ...raw, hidden: { weights: [[NaN, 0, 0, 0]], bias: [0] } }, expected),
    ).toThrow();
  });

  it('returns calibrated probabilities and abstains below the bundled threshold', () => {
    const classifier = loadEffortClassifier(weights(), expected);
    const clear = classifier.judge(Float32Array.from([0, 0, 1, 0]));
    expect(clear.answer).toBe('high');
    expect(clear.abstain).toBe(false);
    const sum = Object.values(clear.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    const unclear = classifier.judge(Float32Array.from([0.1, 0.1, 0.12, 0.1]));
    expect(unclear.abstain).toBe(true);
    expect(classifier.abstains).toBe(true);
    expect(loadEffortClassifier(weights({ abstainBelow: 0 }), expected).abstains).toBe(false);
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

  it('warms a real classification embedding before reporting provider warm-up completion', async () => {
    let complete!: (vectors: Float32Array[]) => void;
    let entered!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pendingEmbedding = new Promise<Float32Array[]>((resolve) => {
      complete = resolve;
    });
    const requests: EmbedRequest[] = [];
    const judge = new LocalEffortProvider({
      engine: {
        available: () => true,
        isReady: () => true,
        warmUp: async () => {},
        embed: (request) => {
          requests.push(request);
          entered();
          return pendingEmbedding;
        },
      },
      classifier: loadEffortClassifier(weights(), expected),
      release: 'bundle-1',
    });
    let ready = false;
    const warming = judge.warmUp().then(() => {
      ready = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    await embeddingStarted;
    expect(ready).toBe(false);
    expect(requests[0]).toMatchObject({
      task: 'classification',
      priority: 'effort',
      overflow: 'truncate',
    });
    expect(requests[0]!.texts).toEqual([effortText(requestInput('warm up'))]);
    complete([Float32Array.from([0, 1, 0, 0])]);
    await warming;
    expect(ready).toBe(true);
  });

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
    expect(requests[0]!.texts).toEqual([effortText(requestInput('thanks'))]);
    await expect(judge.decideRequest(input({ kind: 'compaction' }), cancellation)).rejects.toThrow(
      /compaction/,
    );
  });

  it('passes on why the engine cannot answer', () => {
    expect(provider([0, 0, 0, 1], 'not installed').judge.available()).toBe('not installed');
  });
});
