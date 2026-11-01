import type {
  DecisionCancellation,
  DecisionProvider,
  EffortQuestion,
  ReasoningInput,
} from '@corral/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  type DecisionEngineLike,
  LocalDecisionEffortProvider,
  LocalDecisionMeetingSelector,
} from '../src/decision/providers.ts';
import type { DecisionMeetingSelectionInput } from '../src/decision/text.ts';
import type {
  DecisionInput,
  DecisionRequestOptions,
  DecisionResult,
} from '../src/decision/types.ts';

const cancellation: DecisionCancellation = { aborted: false, onCancel: () => () => {} };
const reasoning = (): ReasoningInput => ({
  kind: 'turn',
  request: 'Fix a typo',
  prevRequest: '',
  prev: '',
  plan: '',
  calls: [],
  step: 0,
  directiveIds: [],
});
const metadata = {
  originalPromptTokens: 60,
  usedPromptTokens: 60,
  inputBudget: 1024,
  inputTruncated: false,
  inputTokenFingerprint: '0123456789abcdef',
  inputTokenFingerprintAlgorithm: 'fnv1a64-le-u32' as const,
  release: 'release1',
  backend: 'cpu' as const,
};
const effortResult = (): DecisionResult => ({
  ...metadata,
  op: 'effort',
  level: 'xhigh',
  logits: [1000, 1001, 1002, 1003],
  probabilities: [0.032058603, 0.087144319, 0.236882818, 0.64391426],
});
const meeting = (): DecisionMeetingSelectionInput => ({
  message: 'Compare their ideas',
  participants: [
    { participantId: '8476782b-d8be-4b84-a119-116e6b7cf351', name: 'Ari', prompt: 'design' },
    { participantId: '15f139fa-2a9a-4016-b797-e806ce0a9ad8', name: 'Bo', prompt: 'testing' },
  ],
  history: [
    {
      id: 'long-run-id-one',
      participantId: '8476782b-d8be-4b84-a119-116e6b7cf351',
      text: 'First idea',
    },
  ],
});
function fake(result: DecisionResult = effortResult()) {
  const requests: { input: DecisionInput; options: DecisionRequestOptions }[] = [];
  const decide = vi.fn(async (input: DecisionInput, options: DecisionRequestOptions) => {
    requests.push({ input, options });
    return result;
  });
  const engine: DecisionEngineLike = {
    available: () => true,
    isReady: () => true,
    warmUp: vi.fn(async () => {}),
    decide,
  };
  return { engine, decide, requests };
}

describe('opt-in native effort provider', () => {
  it('forwards the trained prompt, explicit token budget, cancellation, and a 3 s deadline', async () => {
    const { engine, requests } = fake();
    const provider = new LocalDecisionEffortProvider({
      engine,
      release: 'release1',
      calibration: { version: 'cal1', temperature: 2 },
      inputBudget: 1024,
      now: () => 100,
    });
    const contract: DecisionProvider = provider;
    expect(contract).toMatchObject({
      id: 'local-model',
      privacy: 'local',
      version: 'release1+cal1',
      timeoutMs: 3000,
    });
    const answer = await provider.decideRequest(reasoning(), cancellation);
    expect(answer.answer).toBe('xhigh');
    expect(answer.probabilities.low).toBeCloseTo(0.1015363241, 8);
    expect(answer.probabilities.xhigh).toBeCloseTo(0.4550542339, 8);
    expect(answer).toMatchObject({ abstain: false, evidenceLevel: 'model_probability' });
    expect(requests[0]?.options).toEqual({ deadlineMs: 3100, cancellation });
    expect(requests[0]?.input).toMatchObject({ op: 'effort', inputBudget: 1024 });
    expect(requests[0]?.input.prompt).toContain('Stage: turn\nCurrent request: Fix a typo');
    expect(requests[0]?.input.prompt).toMatch(/<think>\n\n<\/think>\n\n$/);
    expect(requests[0]?.input.prompt).not.toContain('Previous reply:');
  });

  it('leaves low-policy protection to core and abstains only when explicitly configured', async () => {
    const result: DecisionResult = {
      ...metadata,
      op: 'effort',
      level: 'low',
      logits: [Math.log(0.4), Math.log(0.3), Math.log(0.2), Math.log(0.1)],
      probabilities: [0.4, 0.3, 0.2, 0.1],
    };
    const { engine } = fake(result);
    const plain = new LocalDecisionEffortProvider({
      engine,
      release: 'r',
      calibration: { version: 'c', temperature: 1 },
      inputBudget: 1024,
    });
    expect(await plain.decideRequest(reasoning(), cancellation)).toMatchObject({
      answer: 'low',
      abstain: false,
    });
    const calibrated = new LocalDecisionEffortProvider({
      engine,
      release: 'r',
      calibration: { version: 'c', temperature: 1, abstainBelow: 0.5 },
      inputBudget: 1024,
    });
    expect(await calibrated.decideRequest(reasoning(), cancellation)).toMatchObject({
      answer: 'low',
      abstain: true,
    });
  });

  it('rejects compaction and pre-cancelled calls without model work; warmup belongs to engine owner', async () => {
    const { engine, decide } = fake();
    const provider = new LocalDecisionEffortProvider({
      engine,
      release: 'r',
      calibration: { version: 'c', temperature: 1 },
      inputBudget: 1024,
    });
    await expect(
      provider.decideRequest({ ...reasoning(), kind: 'compaction' }, cancellation),
    ).rejects.toThrow('compaction');
    await expect(
      provider.decideRequest(reasoning(), { ...cancellation, aborted: true }),
    ).rejects.toThrow('cancelled');
    await provider.warmUp();
    expect(engine.warmUp).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
  });

  it('uses only the observer excerpt and propagates unavailable state', async () => {
    const { engine, requests } = fake();
    const provider = new LocalDecisionEffortProvider({
      engine,
      release: 'r',
      calibration: { version: 'c', temperature: 1 },
      inputBudget: 1024,
    });
    await provider.decide(
      { input: { excerpt: 'observed excerpt' } } as EffortQuestion,
      cancellation,
    );
    expect(requests[0]?.input.prompt).toContain('Current request: observed excerpt');
    expect(requests[0]?.input.prompt).not.toContain('Previous reply:');
    engine.available = () => 'not installed';
    expect(provider.available()).toBe('not installed');
  });

  it('rejects invalid temperature, logits, and role output without fabricating probabilities', async () => {
    const { engine, decide } = fake();
    for (const temperature of [0, -1, NaN, Infinity])
      expect(
        () =>
          new LocalDecisionEffortProvider({
            engine,
            release: 'r',
            calibration: { version: 'c', temperature },
            inputBudget: 1024,
          }),
      ).toThrow('calibration');
    const provider = new LocalDecisionEffortProvider({
      engine,
      release: 'r',
      calibration: { version: 'c', temperature: 1 },
      inputBudget: 1024,
    });
    decide.mockResolvedValueOnce({ ...metadata, op: 'meeting', participantIds: [] });
    await expect(provider.decideRequest(reasoning(), cancellation)).rejects.toThrow('invalid');
    decide.mockResolvedValueOnce({
      ...effortResult(),
      op: 'effort',
      logits: [NaN, 1, 2, 3],
      level: 'xhigh',
      probabilities: [0, 0, 0, 1],
    });
    await expect(provider.decideRequest(reasoning(), cancellation)).rejects.toThrow('invalid');
    const cold = new LocalDecisionEffortProvider({
      engine,
      release: 'r',
      calibration: { version: 'c', temperature: Number.MIN_VALUE },
      inputBudget: 1024,
    });
    expect((await cold.decideRequest(reasoning(), cancellation)).probabilities).toEqual({
      low: 0,
      medium: 0,
      high: 0,
      xhigh: 1,
    });
  });
});

describe('opt-in native meeting selector', () => {
  it('shares fixed warmup and returns immediately while cold, preserving initialization for a ready selection', async () => {
    const { engine, decide } = fake({ ...metadata, op: 'meeting', participantIds: ['p1'] });
    let ready = false;
    let now = 0;
    let finish!: () => void;
    const warming = new Promise<void>((resolve) => {
      finish = () => {
        ready = true;
        resolve();
      };
    });
    engine.isReady = () => ready;
    const warmUp = vi.fn(() => warming);
    engine.warmUp = warmUp;
    const selector = new LocalDecisionMeetingSelector({
      engine,
      release: 'r',
      inputBudget: 1024,
      now: () => now,
    });
    await expect(selector.select(meeting())).resolves.toBeNull();
    expect(warmUp).toHaveBeenCalledWith();
    expect(decide).not.toHaveBeenCalled();
    const explicitWarmup = selector.warmUp();
    now = 2000; // GPU cold start can exceed the meeting judgment's 1.5s deadline.
    await expect(selector.select(meeting())).resolves.toBeNull();
    expect(decide).not.toHaveBeenCalled();
    expect(ready).toBe(false);
    finish();
    await explicitWarmup;
    await expect(selector.select(meeting())).resolves.toEqual([
      meeting().participants[0]?.participantId,
    ]);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[1].deadlineMs).toBe(3500);
  });

  it('keeps a background warmup failure on the normal meeting fallback path', async () => {
    const { engine, decide } = fake({ ...metadata, op: 'meeting', participantIds: [] });
    engine.isReady = () => false;
    engine.warmUp = vi.fn(async () => {
      throw new Error('/private/native startup error');
    });
    const selector = new LocalDecisionMeetingSelector({ engine, release: 'r', inputBudget: 1024 });
    await expect(selector.select(meeting())).resolves.toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('maps compact results back to original IDs without exposing structured UUIDs to the model', async () => {
    const { engine, requests } = fake({ ...metadata, op: 'meeting', participantIds: ['p2', 'p1'] });
    const selector = new LocalDecisionMeetingSelector({
      engine,
      release: 'r',
      inputBudget: 1024,
      now: () => 500,
    });
    const input = meeting();
    const before = structuredClone(input);
    expect(await selector.select(input)).toEqual([
      input.participants[1]?.participantId,
      input.participants[0]?.participantId,
    ]);
    expect(requests[0]?.options).toEqual({ deadlineMs: 2000 });
    expect(requests[0]?.input).toMatchObject({
      op: 'meeting',
      inputBudget: 1024,
      participantIds: ['p1', 'p2'],
    });
    expect(requests[0]?.input.prompt).toContain('p1: Ari; role: design');
    expect(requests[0]?.input.prompt).toContain('[t1] p1: First idea');
    for (const participant of input.participants)
      expect(requests[0]?.input.prompt).not.toContain(participant.participantId);
    expect(requests[0]?.input.prompt).not.toContain('long-run-id-one');
    expect(input).toEqual(before);
  });

  it('keeps NONE empty, rejects malformed/out-of-roster output, and returns null on failure', async () => {
    const { engine, decide } = fake({ ...metadata, op: 'meeting', participantIds: [] });
    const selector = new LocalDecisionMeetingSelector({ engine, release: 'r', inputBudget: 1024 });
    expect(await selector.select(meeting())).toEqual([]);
    for (const participantIds of [['p3'], ['p1', 'p1'], ['real-uuid']]) {
      decide.mockResolvedValueOnce({ ...metadata, op: 'meeting', participantIds });
      expect(await selector.select(meeting())).toBeNull();
    }
    decide.mockRejectedValueOnce(new Error('/private/runtime raw text'));
    expect(await selector.select(meeting())).toBeNull();
    decide.mockResolvedValueOnce(effortResult());
    expect(await selector.select(meeting())).toBeNull();
  });

  it('does not start unavailable or invalid rosters and drops late results', async () => {
    const { engine, decide } = fake({ ...metadata, op: 'meeting', participantIds: ['p1'] });
    let now = 0;
    const selector = new LocalDecisionMeetingSelector({
      engine,
      release: 'r',
      inputBudget: 1024,
      now: () => now,
    });
    const invalid = meeting();
    const first = invalid.participants[0];
    if (!first) throw new Error('test participant is missing');
    invalid.participants[1] = { ...first };
    expect(await selector.select(invalid)).toBeNull();
    expect(decide).not.toHaveBeenCalled();
    engine.available = () => 'unavailable';
    expect(await selector.select(meeting())).toBeNull();
    engine.available = () => true;
    decide.mockImplementationOnce(async () => {
      now = 1501;
      return { ...metadata, op: 'meeting', participantIds: ['p1'] };
    });
    expect(await selector.select(meeting())).toBeNull();
  });

  it('uses a snapshot of participant identities when caller objects change during inference', async () => {
    const { engine, decide } = fake({ ...metadata, op: 'meeting', participantIds: ['p1'] });
    let resolve!: (value: DecisionResult) => void;
    decide.mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const selector = new LocalDecisionMeetingSelector({ engine, release: 'r', inputBudget: 1024 });
    const input = meeting();
    const original = input.participants[0]?.participantId;
    const pending = selector.select(input);
    input.participants[0] = { participantId: 'changed-later', name: 'Changed', prompt: '' };
    resolve({ ...metadata, op: 'meeting', participantIds: ['p1'] });
    expect(await pending).toEqual([original]);
  });

  it('keeps the six-person model output compact and rejects a roster beyond that contract', async () => {
    const aliases = Array.from({ length: 6 }, (_, index) => `p${index + 1}`);
    const { engine, requests, decide } = fake({
      ...metadata,
      op: 'meeting',
      participantIds: aliases,
    });
    const selector = new LocalDecisionMeetingSelector({ engine, release: 'r', inputBudget: 1024 });
    const input = meeting();
    input.participants = aliases.map((_, index) => ({
      participantId: `8476782b-d8be-4b84-a119-116e6b7cf35${index}`,
      name: `Person ${index + 1}`,
      prompt: '',
    }));
    input.history = [];
    expect(await selector.select(input)).toEqual(
      input.participants.map((participant) => participant.participantId),
    );
    expect(requests[0]?.input).toMatchObject({ participantIds: aliases });
    input.participants.push({ participantId: 'seventh', name: 'Seventh', prompt: '' });
    expect(await selector.select(input)).toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
