import type { DecisionCancellation, MeetingSelectionInput } from '@corral/contracts';
import { describe, expect, it, vi } from 'vitest';
import { DecisionEngineError, LocalDecisionEngine } from '../src/decision/engine.ts';
import {
  LocalDecisionEffortProvider,
  LocalDecisionMeetingSelector,
} from '../src/decision/providers.ts';
import type { DecisionEngineStatus, DecisionInput, DecisionResult } from '../src/decision/types.ts';
import { requestInput } from '../src/effort/preprocess.ts';
import { LocalEffortProvider } from '../src/effort/provider.ts';
import { LocalEmbeddingEngine } from '../src/engine/engine.ts';
import { createLocalIntelligence } from '../src/factory.ts';
import * as publicApi from '../src/index.ts';
import { fakeLauncher, flush, markInstalled } from './fake-helper.ts';
import { tempDir, testBundle, testWeights } from './helpers.ts';

const cancellation: DecisionCancellation = { aborted: false, onCancel: () => () => {} };
const selection: MeetingSelectionInput = {
  message: 'Ask the reviewer',
  participants: [
    { participantId: 'a', name: 'Author', prompt: 'implementation' },
    { participantId: 'b', name: 'Reviewer', prompt: 'review' },
  ],
  history: [],
};
const identity = { id: 'verified-candidate-v1', sha256: 'a'.repeat(64) };
const effortConfig = {
  calibration: { version: 'temperature-v1', temperature: 2 },
  inputBudget: 1024,
};
const meetingConfig = { inputBudget: 1024 };

function decision() {
  const engine = new LocalDecisionEngine({
    command: {
      executable: '/private/helper',
      args: ['/private/model.gguf'],
      cwd: '/private',
      env: {},
    },
    backend: 'cpu',
    release: 'engine-release',
    contextTokens: 2048,
    warmup: [{ op: 'effort', prompt: 'fixed non-sensitive warmup' }],
    launch: () => {
      throw new Error('unexpected native launch');
    },
  });
  vi.spyOn(engine, 'available').mockReturnValue(true);
  vi.spyOn(engine, 'isReady').mockReturnValue(true);
  const warmUp = vi.spyOn(engine, 'warmUp').mockResolvedValue();
  const close = vi.spyOn(engine, 'close').mockResolvedValue();
  const status = vi.spyOn(engine, 'status').mockReturnValue({
    state: 'ready',
    requestedBackend: 'cpu',
    actualBackend: 'cpu',
    release: 'engine-release',
    calibrationVersion: 'calibration-v1',
    error: null,
  });
  const decide = vi
    .spyOn(engine, 'decide')
    .mockImplementation(async (input: DecisionInput): Promise<DecisionResult> => {
      const base = {
        originalPromptTokens: 60,
        usedPromptTokens: 60,
        inputBudget: input.inputBudget ?? null,
        inputTruncated: false,
        inputTokenFingerprint: '0123456789abcdef',
        inputTokenFingerprintAlgorithm: 'fnv1a64-le-u32' as const,
        release: 'engine-release',
        backend: 'cpu' as const,
      };
      return input.op === 'meeting'
        ? { ...base, op: 'meeting', participantIds: ['p2'] }
        : {
            ...base,
            op: 'effort',
            level: 'high',
            logits: [0, 0, 2, 0],
            probabilities: [0.096255, 0.096255, 0.711235, 0.096255],
          };
    });
  return { engine, warmUp, close, status, decide };
}

function setup(
  options: { effort?: typeof effortConfig; meeting?: typeof meetingConfig } | null,
  extra: Record<string, unknown> = {},
) {
  const root = tempDir();
  const bundle = testBundle();
  const legacy = fakeLauncher();
  markInstalled(root, bundle);
  const selected = decision();
  const li = createLocalIntelligence({
    root,
    bundle,
    effortWeights: testWeights(),
    meetingWeights: {
      schemaVersion: 1,
      version: 'old-meeting',
      dims: 4,
      baseModelSha256: bundle.model.sha256,
      preprocessVersion: 'meeting-text-v1',
      intent: { weights: Array.from({ length: 4 }, () => [0, 0, 0, 0]), bias: [0, 0, 10, 0] },
      rank: { weights: [0, 0, 0, 0, 0, 0], bias: 0 },
      allThreshold: 0.8,
      minimumScore: 0.5,
      minimumMargin: 0.1,
    },
    launch: legacy.launch,
    env: {},
    platform: 'linux',
    arch: 'x64',
    ...(options ? { decision: { engine: selected.engine, identity, ...options } } : {}),
    ...extra,
  });
  const embed = vi
    .spyOn(li.engine, 'embed')
    .mockImplementation(async (request) =>
      request.texts.map(() => Float32Array.from([0.5, 0.5, 0.5, 0.5])),
    );
  return { li, selected, embed, legacy };
}

describe('explicit decision factory override', () => {
  it('keeps the default providers and status unchanged without an override', async () => {
    const { li, selected, embed } = setup(null);
    expect(li.effort).toBeInstanceOf(LocalEffortProvider);
    expect(li.status()).not.toHaveProperty('decision');
    expect(li.meeting.warmUp).toBeUndefined();
    await expect(
      li.effort.decideRequest(requestInput('Inspect'), cancellation),
    ).resolves.toMatchObject({ answer: 'medium' });
    await expect(li.meeting.select(selection)).resolves.toEqual(['a', 'b']);
    expect(embed.mock.calls.flatMap(([request]) => request.texts)).toEqual([
      'request: Inspect',
      'Ask the reviewer',
      'implementation',
      'review',
    ]);
    await li.close();
    expect(selected.close).not.toHaveBeenCalled();
  });

  it.each(['effort', 'meeting'] as const)(
    'routes only the explicitly selected %s role to the decision engine',
    async (role) => {
      const { li, selected, embed } = setup(
        role === 'effort' ? { effort: effortConfig } : { meeting: meetingConfig },
      );
      expect(li.engine).toBeInstanceOf(LocalEmbeddingEngine);
      expect(li.status().decision?.roles).toEqual([role]);
      await expect(
        li.effort.decideRequest(requestInput('Inspect'), cancellation),
      ).resolves.toMatchObject({ answer: role === 'effort' ? 'high' : 'medium' });
      await expect(li.meeting.select(selection)).resolves.toEqual(
        role === 'meeting' ? ['b'] : ['a', 'b'],
      );
      expect(selected.decide).toHaveBeenCalledTimes(1);
      expect(selected.decide.mock.calls[0]?.[0].op).toBe(role);
      expect(embed.mock.calls.flatMap(([request]) => request.texts)).toEqual(
        role === 'effort' ? ['Ask the reviewer', 'implementation', 'review'] : ['request: Inspect'],
      );
      await li.close();
      expect(selected.close).toHaveBeenCalledTimes(1);
    },
  );

  it('prewarms a selected meeting role independently of an unselected effort provider', async () => {
    const { li, selected } = setup({ meeting: meetingConfig });
    const oldWarmUp = vi.spyOn(li.engine, 'warmUp').mockResolvedValue();
    expect(typeof li.meeting.warmUp).toBe('function');
    await li.meeting.warmUp?.();
    expect(selected.warmUp).toHaveBeenCalledTimes(1);
    expect(oldWarmUp).not.toHaveBeenCalled();
    await li.close();
  });

  it('shares one supplied engine for both roles and does not load replaced legacy weights', async () => {
    const { li, selected, embed, legacy } = setup(
      { effort: effortConfig, meeting: meetingConfig },
      { effortWeights: {}, meetingWeights: {} },
    );
    expect(li.effort).toBeInstanceOf(LocalDecisionEffortProvider);
    expect(li.meeting).toBeInstanceOf(LocalDecisionMeetingSelector);
    expect(li.effort.version).toBe('verified-candidate-v1+temperature-v1');
    await li.effort.warmUp();
    expect(selected.warmUp).toHaveBeenCalledTimes(1);
    await li.effort.decideRequest(requestInput('Inspect'), cancellation);
    await li.meeting.select(selection);
    expect(selected.decide.mock.calls.map(([input]) => input.op)).toEqual(['effort', 'meeting']);
    expect(embed).not.toHaveBeenCalled();
    expect(legacy.helpers).toHaveLength(0);
    const first = li.close();
    expect(li.close()).toBe(first);
    await first;
    expect(selected.close).toHaveBeenCalledTimes(1);
  });

  it('returns selected-role failures to Core without hidden legacy classifier fallback', async () => {
    const { li, selected, embed } = setup({ effort: effortConfig, meeting: meetingConfig });
    selected.decide.mockRejectedValue(new DecisionEngineError('helper_failed'));
    await expect(
      li.effort.decideRequest(requestInput('Inspect'), cancellation),
    ).rejects.toMatchObject({ code: 'helper_failed' });
    await expect(li.meeting.select(selection)).resolves.toBeNull();
    expect(embed).not.toHaveBeenCalled();
    selected.engine.available = () => 'unavailable';
    await expect(li.effort.decideRequest(requestInput('Inspect'), cancellation)).rejects.toThrow(
      'unavailable',
    );
    await expect(li.meeting.select(selection)).resolves.toBeNull();
    expect(selected.decide).toHaveBeenCalledTimes(2);
    expect(embed).not.toHaveBeenCalled();
    await li.close();
  });

  it('waits for every owned close even when another close fails', async () => {
    const { li, selected } = setup({ effort: effortConfig, meeting: meetingConfig });
    let finish!: () => void;
    selected.close.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    vi.spyOn(li.engine, 'close').mockRejectedValue(new Error('embedding stop failed'));
    let settled = false;
    const closing = li.close().catch((error: Error) => {
      settled = true;
      return error.message;
    });
    await flush();
    expect(settled).toBe(false);
    expect(selected.close).toHaveBeenCalledTimes(1);
    finish();
    await expect(closing).resolves.toBe('embedding stop failed');
  });

  it('publishes only identity, roles and safe decision state/backend/error fields', async () => {
    const { li, selected } = setup({ effort: effortConfig });
    selected.status.mockReturnValue({
      state: 'error',
      requestedBackend: 'gpu',
      actualBackend: null,
      release: '/private/model.gguf',
      calibrationVersion: '/private/calibration.json',
      error: 'native error /private/path',
    } as unknown as DecisionEngineStatus);
    expect(li.status().decision).toEqual({
      roles: ['effort'],
      identity,
      state: 'error',
      requestedBackend: 'gpu',
      actualBackend: null,
      error: 'helper_failed',
    });
    expect(JSON.stringify(li.status().decision)).not.toMatch(/private|native error/);
    selected.status.mockReturnValue({
      state: 'error',
      requestedBackend: 'gpu',
      actualBackend: null,
      release: 'safe',
      calibrationVersion: null,
      error: 'startup_timeout',
    });
    expect(li.status().decision?.error).toBe('startup_timeout');
    await li.close();
  });

  it('projects public identity fields without copying extra artifact paths or later mutations', async () => {
    const selected = decision();
    const supplied = { ...identity, artifactPath: '/private/model.gguf' };
    const li = createLocalIntelligence({
      root: tempDir(),
      env: {},
      decision: {
        engine: selected.engine,
        identity: supplied,
        effort: effortConfig,
      },
    });
    supplied.id = 'changed-after-creation';
    expect(li.status().decision?.identity).toEqual(identity);
    expect(JSON.stringify(li.status().decision)).not.toContain('/private');
    await li.close();
  });

  it('requires an enabled role and a path-free public model identity', () => {
    const selected = decision();
    const options = {
      root: tempDir(),
      bundle: testBundle(),
      effortWeights: testWeights(),
      env: {},
    };
    expect(() =>
      createLocalIntelligence({ ...options, decision: { engine: selected.engine, identity } }),
    ).toThrow();
    expect(() =>
      createLocalIntelligence({
        ...options,
        decision: {
          engine: selected.engine,
          identity: { ...identity, id: '/private/model.gguf' },
          effort: effortConfig,
        },
      }),
    ).toThrow();
    expect(selected.close).not.toHaveBeenCalled();
  });

  it('exports the optional engine and adapters through the package entry point', () => {
    expect(publicApi.LocalDecisionEngine).toBe(LocalDecisionEngine);
    expect(publicApi.LocalDecisionEffortProvider).toBe(LocalDecisionEffortProvider);
    expect(publicApi.LocalDecisionMeetingSelector).toBe(LocalDecisionMeetingSelector);
  });
});
