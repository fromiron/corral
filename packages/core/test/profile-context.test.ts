import type { ModelProfileSnapshot } from '@corral/contracts';
import { FakeClock, Gate, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { expect, it } from 'vitest';
import { parseWorkspaceConfig } from '../src/config.ts';
import {
  Coordinator,
  createAutoStarter,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';
import { resolveProfileContext } from '../src/profile-context.ts';

it('[TC-CONTEXT-001-H] freezes policies before the chooser and preserves them for later roles; the next Run sees the edit', async () => {
  let contextWindow = 64000;
  let revision = 'rev-a';
  const seen: ModelProfileSnapshot[] = [];
  const scripted = new ScriptedAgentAdapter({ turns: 1 });
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: {
      start(input, host) {
        seen.push(input.model);
        return scripted.start(input, host);
      },
    },
    models: {
      resolve(profile) {
        return {
          ok: true,
          snapshot: {
            profile,
            provider: null,
            modelId: null,
            auth: 'mock',
            contextWindow,
            contextPolicy: resolveProfileContext(
              { contextWindow },
              { contextWindow: 128000, source: 'catalog' },
              revision,
              4096,
            ).policy!,
          },
        };
      },
    },
  });
  const entered = new Gate(),
    release = new Gate();
  const starter = createAutoStarter({
    prepareModels: (request) =>
      coordinator.prepareModels([request.choice.modelProfile], request.mode),
    startRun: (request, _signal, models) => coordinator.startRun(request, models),
    route: async ({ models }) => {
      expect(models?.['model-a']?.contextWindow).toBe(64000);
      entered.open();
      await release.wait();
      return { ok: true, text: '{"template":"write_review","reason":"review"}', usage: null };
    },
  });
  const pending = starter.start(
    {
      commandId: 'context_a',
      brief: 'Write a short note.',
      mode: 'mock',
      choice: { modelProfile: 'model-a' },
    },
    { fileTools: false },
  );
  await entered.wait();
  contextWindow = 96000;
  revision = 'rev-b';
  release.open();
  const a = await pending;
  expect(a.runId).not.toBeNull();
  await waitForProjection(
    new InProcessTransport(coordinator),
    a.runId!,
    (p) => p.status === 'succeeded',
  );
  expect(seen.length).toBeGreaterThan(1);
  expect(
    seen.every(
      (model) => model.contextPolicy?.configRevision === 'rev-a' && model.contextWindow === 64000,
    ),
  ).toBe(true);
  const b = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'context_b',
    definition: coordinator.getRunSnapshot(a.runId!)!.definition,
    mode: 'mock',
  });
  expect(coordinator.getRunSnapshot(b.runId!)?.models['model-a']?.contextPolicy).toMatchObject({
    configRevision: 'rev-b',
    contextWindow: 96000,
  });
  await waitForProjection(
    new InProcessTransport(coordinator),
    b.runId!,
    (p) => p.status === 'succeeded',
  );
});

it('[TC-CONTEXT-001-H] [TC-CONTEXT-001-N] uses adaptive defaults and validates explicit policies after resolving their source', () => {
  const base = { contextWindow: 32000, source: 'fallback' as const };
  const legacy = resolveProfileContext({}, base, 'rev-a', 4096);
  expect(legacy.errors).toEqual([]);
  expect(legacy.policy).toMatchObject({
    contextWindow: 32000,
    reserveTokens: 16000,
    keepRecentTokens: 7999,
    explicit: false,
    warnings: [],
  });
  expect(resolveProfileContext({ contextWindow: 32000 }, base, 'rev-a', 4096).errors).toEqual([]);
  const valid = resolveProfileContext(
    { compaction: { keepRecentTokens: 15999 } },
    base,
    'rev-b',
    4096,
  );
  expect(valid.errors).toEqual([]);
  expect(valid.policy?.sources).toEqual({
    contextWindow: 'fallback',
    reserveTokens: 'adaptive',
    keepRecentTokens: 'profile',
  });
  expect(
    resolveProfileContext({ compaction: { keepRecentTokens: 16000 } }, base, 'rev-b', 4096).errors,
  ).not.toEqual([]);
  expect(
    resolveProfileContext({ compaction: { reserveTokens: 32000 } }, base, 'rev-b', 4096).errors,
  ).not.toEqual([]);
  expect(
    resolveProfileContext(
      { contextWindow: 64000, compaction: { reserveTokens: 0, keepRecentTokens: 0 } },
      base,
      'rev-b',
      4096,
    ),
  ).toMatchObject({
    errors: [],
    policy: {
      contextWindow: 64000,
      reserveTokens: 0,
      keepRecentTokens: 0,
      warnings: ['reserve_below_output', 'above_model_limit'],
    },
  });
  expect(resolveProfileContext({}, base, 'rev-c', 4096).policy?.explicit).toBe(false);
});

it('[TC-CONTEXT-001-H] accepts explicit zero reserves and omission as different profile settings', () => {
  const config = {
    schemaVersion: '0.1',
    modelProfiles: [
      {
        id: 'model-a',
        provider: 'openai',
        model: 'fixture',
        contextWindow: 120000,
        compaction: { reserveTokens: 0, keepRecentTokens: 0 },
      },
    ],
  };
  expect(parseWorkspaceConfig(config)).toEqual({ ok: true, config });
  const absent = {
    schemaVersion: '0.1',
    modelProfiles: [{ id: 'model-a', provider: 'openai', model: 'fixture' }],
  };
  expect(parseWorkspaceConfig(absent)).toEqual({ ok: true, config: absent });
});

it('[TC-CONTEXT-001-N] keeps credential and integer validation outside the exact numeric compaction fields', () => {
  const profile = { id: 'model-a', provider: 'openai', model: 'fixture' };
  for (const invalid of [null, '0', 0.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      parseWorkspaceConfig({
        schemaVersion: '0.1',
        modelProfiles: [{ ...profile, compaction: { reserveTokens: invalid } }],
      }).ok,
    ).toBe(false);
  }
  for (const contextWindow of [0, -1, 1.5, 10_000_001, null, '64000', Infinity, NaN]) {
    expect(
      parseWorkspaceConfig({ schemaVersion: '0.1', modelProfiles: [{ ...profile, contextWindow }] })
        .ok,
    ).toBe(false);
  }
  for (const change of [
    { reserveTokens: 123 },
    { compaction: { accessToken: 123 } },
    { compaction: { reserveTokens: 'secret-sentinel' } },
  ]) {
    const result = parseWorkspaceConfig({
      schemaVersion: '0.1',
      modelProfiles: [{ ...profile, ...change }],
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-sentinel');
  }
});
