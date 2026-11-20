import {
  type AgentHost,
  type AgentStartInput,
  type CorralDefinition,
  canonicalJson,
  type EffectiveHarnessSnapshot,
  type StartRunRequest,
  type ToolDescriptor,
} from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it, vi } from 'vitest';
import {
  Coordinator,
  type CoordinatorDeps,
  exportRunArchive,
  type HarnessResolver,
  InMemoryRunStore,
  sha256Hex,
} from '../src/index.ts';
import { roleSkillCases } from './harness-role-skill-cases.ts';

const minimal = { profileId: 'role-skills-minimal', revision: 1 };
const bound = { profileId: 'writer-style', revision: 2 };
const sessionId = 'session_1';
const denied = { runId: null, receipt: { error: { code: 'CAPABILITY_DENIED' } } };

function ref(key: string) {
  return { resourceHash: sha256Hex(key), entry: `skills/${key}/SKILL.md` };
}
function snapshot(keys: string[], binding = minimal): EffectiveHarnessSnapshot {
  return {
    binding,
    policy: 'strict',
    piVersion: '1.3.0',
    policyRevision: 1,
    snapshotHash: sha256Hex(canonicalJson({ keys, binding })),
    layers: [{ scope: 'role', binding }],
    resources: keys.map((key) => ({
      hash: ref(key).resourceHash,
      entry: ref(key).entry,
      kind: 'skill',
      name: key,
      skillName: key,
      skillMode: key === 'mandatory' ? 'mandatory' : key === 'explicit' ? 'explicit' : 'auto',
      version: '1.0.0',
      required: key === 'required',
    })),
    allowedTools: ['read', 'write_artifact', 'submit_result'],
    tools: [],
    diagnostics: [],
  };
}
function writer(keys?: string[]) {
  const definition = linearCorral(['writer']);
  if (keys !== undefined) definition.roles[0]!.skills = keys.map(ref);
  return definition;
}

/** Hold the first execution so the test can drive its host at a specific protocol boundary. */
function setup(harnesses?: HarnessResolver, deps: Partial<CoordinatorDeps> = {}) {
  const store = new InMemoryRunStore();
  const started = new Gate();
  const ended = new Gate();
  const stop = new Gate();
  const clock = new FakeClock();
  let execution!: { input: AgentStartInput; host: AgentHost };
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    store,
    ...(harnesses ? { harnesses } : {}),
    agents: {
      async start(input, host) {
        execution = { input, host };
        started.open();
        return {
          cancel: async () => stop.open(),
          waitForSettlement: async () => {
            await stop.wait();
            return { outcome: 'failed', error: 'worker stopped' };
          },
        };
      },
    },
    onRunEnded: () => ended.open(),
    ...deps,
  });
  return {
    start: (definition: CorralDefinition, options: Partial<StartRunRequest> = {}) =>
      coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'start',
        sessionId,
        definition,
        mode: 'mock',
        ...options,
      }),
    execution: async () => {
      await started.wait();
      return execution;
    },
    coordinator,
    store,
    stop,
    ended,
  };
}
const readTool: ToolDescriptor = {
  name: 'read',
  source: 'corral',
  schemaHash: sha256Hex('read'),
  exposure: 'direct',
  sideEffect: 'none',
  annotations: { readOnlyHint: true },
};
const fixtureModel = (isolated = false): NonNullable<CoordinatorDeps['models']> => ({
  resolve: (profile) => ({
    ok: true,
    snapshot: {
      profile,
      provider: 'fixture',
      modelId: 'fixture',
      auth: 'api_key',
      ...(isolated ? { workerIsolation: 'linux-bwrap' as const } : {}),
    },
  }),
});

describe('role-selected skills at the Coordinator boundary', () => {
  it.each(roleSkillCases)('$title', async (row) => {
    const definition = writer(row.skills);
    const role = definition.roles[0]!;
    if (row.bound) role.harness = bound;
    // Resource lookup/merge belongs to the resolver; the Coordinator must pass exactly this
    // role's authored refs and pin (or reject) the answer, without doing its own selection.
    const effective = snapshot(row.expected ?? [], row.bound ? bound : minimal);
    if (row.defaults)
      effective.layers!.unshift({
        scope: 'project',
        binding: { profileId: 'project', revision: 3 },
      });
    const resolve = vi.fn<HarnessResolver['resolve']>(() => (row.problem ? null : effective));
    const s = setup({ resolve });
    const result = s.start(definition);
    if (!row.bound && row.skills === undefined) {
      expect(resolve).not.toHaveBeenCalled();
    } else {
      expect(resolve).toHaveBeenCalledExactlyOnceWith(
        role.harness,
        expect.objectContaining({ roles: [role] }),
        role.id,
        { sessionId },
      );
    }
    if (row.problem) {
      expect(result).toMatchObject(denied);
      expect(s.store.listRuns()).toEqual([]);
      return;
    }
    expect(result.receipt.error).toBeUndefined();
    const { input } = await s.execution();
    const pinned = s.store.getRun(input.runId)!.snapshot;
    if (!row.bound && row.skills === undefined) {
      expect(input).not.toHaveProperty('harness');
      expect(pinned).not.toHaveProperty('harnesses');
      expect(canonicalJson(input.role)).toBe(canonicalJson(role));
      const legacy = setup();
      expect(legacy.start(definition)).toEqual(result);
      const baseline = await legacy.execution();
      expect(canonicalJson(input)).toBe(canonicalJson(baseline.input));
      expect(canonicalJson(pinned)).toBe(canonicalJson(legacy.store.getRun(input.runId)!.snapshot));
      expect(canonicalJson(s.store.readEvents(input.runId, 0))).toBe(
        canonicalJson(legacy.store.readEvents(input.runId, 0)),
      );
      legacy.stop.open();
    } else {
      expect(input.harness).toEqual(effective);
      expect(pinned.harnesses).toEqual({ [role.id]: effective });
      expect(input.role.harness).toEqual(role.harness);
    }
    s.stop.open();
  });

  it.each([{ keys: [] }, { keys: ['first'] }])(
    'a mock run with no resolver runs a skills-only role without skills ($keys)',
    async ({ keys }) => {
      const s = setup();
      const definition = writer(keys);
      expect(s.start(definition).receipt.error).toBeUndefined();
      const { input } = await s.execution();
      expect(input).not.toHaveProperty('harness');
      expect(s.store.getRun(input.runId)!.snapshot).not.toHaveProperty('harnesses');
      s.stop.open();
    },
  );

  it('a live run with no resolver refuses a skills-only role before a Run exists', () => {
    const s = setup(undefined, { models: fixtureModel() });
    expect(s.start(writer(['first']), { mode: 'live' })).toMatchObject(denied);
    expect(s.start(writer([]), { mode: 'live', commandId: 'start_empty' })).toMatchObject(denied);
    expect(s.store.listRuns()).toEqual([]);
  });

  it.each(['mock', 'live'] as const)(
    'a %s run with no resolver refuses a role with a pinned harness',
    (mode) => {
      const s = setup(undefined, { models: fixtureModel() });
      const definition = writer(['first']);
      definition.roles[0]!.harness = bound;
      expect(s.start(definition, { mode })).toMatchObject(denied);
      const pinnedOnly = writer();
      pinnedOnly.roles[0]!.harness = bound;
      expect(s.start(pinnedOnly, { mode, commandId: 'start_pinned' })).toMatchObject(denied);
      expect(s.store.listRuns()).toEqual([]);
    },
  );

  it.each([
    { tag: 'profile', changed: { binding: bound } },
    { tag: 'revision', changed: { binding: { ...minimal, revision: 2 } } },
    { tag: 'policy', changed: { policy: 'trusted-native' as const } },
  ])('refuses a resolver snapshot that substitutes the minimal $tag', ({ changed }) => {
    const s = setup({ resolve: () => ({ ...snapshot([]), ...changed }) });
    expect(s.start(writer([]))).toMatchObject(denied);
  });

  it('does not permit a run override on a role with only skills', () => {
    const resolve = vi.fn(() => snapshot([]));
    const s = setup({ resolve });
    expect(s.start(writer([]), { harnessOverrides: { writer_role: bound } })).toMatchObject({
      runId: null,
      receipt: {
        error: { code: 'CAPABILITY_DENIED', message: expect.stringContaining('bound harness') },
      },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['review_only', 'isolated'])(
    'preserves the %s restrictions on resolved project tools',
    (boundary) => {
      const effective = snapshot([]);
      effective.projectTools = {
        projectId: 'p',
        revision: 1,
        hash: sha256Hex('p'),
        mcpServerIds: ['server'],
        checkIds: [],
        lspServerIds: [],
      };
      const s = setup(
        { resolve: () => effective },
        { models: fixtureModel(boundary === 'isolated') },
      );
      const definition = writer([]);
      if (boundary === 'review_only') definition.input.taskScope = 'review_only';
      expect(s.start(definition)).toMatchObject(denied);
      expect(s.store.listRuns()).toEqual([]);
    },
  );

  it('cannot use meeting answer privileges for a skill-only role', () => {
    const resolve = vi.fn(() => snapshot([]));
    const s = setup({ resolve });
    const meeting = { sessionId, roundId: 'round_1', participantId: 'writer' };
    expect(s.start(writer([]), { meeting })).toMatchObject(denied);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('cannot silently discard an observer’s selected skills or activate the SDK for it', () => {
    const definition = writer();
    definition.roles.push({
      ...definition.roles[0]!,
      id: 'advisor_role',
      skills: [ref('first')],
      allowedWorkTools: [],
      allowedCollaborationTools: [],
    });
    definition.nodes.push({
      id: 'advisor',
      type: 'agent',
      label: 'advisor',
      roleId: 'advisor_role',
      invocation: 'observer',
      outputName: 'notes',
      review: { interval: 1, maxRequestsPerReview: 8 },
    });
    definition.capabilityLinks.push({
      id: 'watch',
      kind: 'advise',
      sourceNodeId: 'advisor',
      targetNodeId: 'writer',
    });
    const s = setup({ resolve: () => snapshot(['first']) });
    expect(s.start(definition)).toMatchObject(denied);
  });

  it.each([false, true])('shared consultations use the pinned ask permission (%s)', async (ask) => {
    const definition = writer(['first']);
    definition.sharedOutrider = {
      modelProfile: 'model-a',
      principles: 'Review answers.',
      targets: { kind: 'all' },
    };
    const effective = snapshot(['first']);
    if (ask) effective.allowedTools.push('ask');
    const s = setup({ resolve: () => effective });
    expect(s.start(definition).receipt.error).toBeUndefined();
    const { input, host } = await s.execution();
    expect(input.capabilities.askTo).toHaveLength(ask ? 1 : 0);
    expect(input.harness).toEqual(effective);
    await expect(host.prepareModelRequest()).rejects.toThrow('harness not loaded');
    await host.simulateHarness!();
    expect((await host.prepareModelRequest()).modelCallId).toBeTruthy();
    const types = s.store.readEvents(input.runId, 0).map((e) => e.type);
    expect(types).toContain('harness.simulated');
    for (const type of ['harness.loaded', 'skill.read', 'model.payload_recorded'])
      expect(types).not.toContain(type);
    s.stop.open();
  });

  it('reads only this role’s pinned skill; neither listing it nor reading it proves payload delivery', async () => {
    const effective = snapshot(['first']);
    const body = 'private fixture skill bytes';
    const readSkill = vi.fn((_snapshot: EffectiveHarnessSnapshot, path: string) => ({
      path,
      resourceHash: ref('first').resourceHash,
      text: body,
      sha256: sha256Hex(body),
    }));
    const files = {
      available: () => true,
      execute: vi.fn(async () => ({ text: 'workspace content' })),
    };
    const s = setup({ resolve: () => effective, readSkill }, { files, models: fixtureModel() });
    expect(s.start(writer(['first']), { mode: 'live' }).receipt.error).toBeUndefined();
    const { input, host } = await s.execution();
    const read = (path: string) => host.invokeTool({ name: 'read', args: { path } });
    await expect(read(ref('first').entry)).rejects.toThrow('harness not loaded');
    await expect(host.simulateHarness!()).rejects.toThrow(/simulation/);
    await host.reportHarness!({
      ok: true,
      snapshotHash: effective.snapshotHash,
      tools: [readTool],
      diagnostics: [],
    });
    for (const path of [ref('second').entry, 'workspace.txt'])
      expect((await read(path)).ok).toBe(false);
    expect(readSkill).not.toHaveBeenCalled();
    expect(files.execute).not.toHaveBeenCalled();
    expect(s.store.readEvents(input.runId, 0).some((e) => e.type === 'skill.read')).toBe(false);
    expect((await read(ref('first').entry)).ok).toBe(true);
    expect(readSkill).toHaveBeenCalledExactlyOnceWith(effective, ref('first').entry);
    const events = s.store.readEvents(input.runId, 0);
    expect(events.filter((e) => e.type === 'skill.read')).toMatchObject([
      {
        payload: {
          resourceHash: ref('first').resourceHash,
          skillName: 'first',
          bodyHash: sha256Hex(body),
        },
      },
    ]);
    expect(events.some((e) => e.type === 'model.payload_recorded')).toBe(false);
    expect(canonicalJson(events)).not.toContain(body);
    expect(canonicalJson(exportRunArchive(s.store, input.runId))).not.toContain(body);
    s.stop.open();
  });

  it('pins distinct worker inputs before launch and never re-resolves in-flight work', async () => {
    const definition = linearCorral(['writer', 'editor', 'publisher']);
    definition.roles[0]!.skills = [ref('first')];
    definition.roles[1]!.skills = [ref('second')];
    const resolve = vi.fn<HarnessResolver['resolve']>((_binding, team, id) => {
      const selected = team.roles.find((role) => role.id === id)!.skills!;
      return snapshot(selected.map((skill) => skill.entry.split('/')[1]!));
    });
    const inputs: AgentStartInput[] = [];
    const mock = new ScriptedAgentAdapter({ turns: 1 });
    const s = setup(
      { resolve },
      {
        agents: {
          async start(input, host) {
            inputs.push(input);
            if (input.harness) await host.simulateHarness!();
            return mock.start(input, host);
          },
        },
      },
    );
    const result = s.start(definition);
    expect(result.receipt.error).toBeUndefined();
    resolve.mockImplementation(() => null);
    await s.ended.wait();
    expect(s.store.getRun(result.runId!)!.projection.status).toBe('succeeded');
    const delivered = inputs.map((input) => [
      input.nodeId,
      input.harness?.resources.map((r) => r.hash),
    ]);
    expect(delivered).toEqual([
      ['writer', [ref('first').resourceHash]],
      ['editor', [ref('second').resourceHash]],
      ['publisher', undefined],
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('rechecks pinned skills for checkpoint preview without making released context resumable', async () => {
    const effective = snapshot(['first']);
    const resolve = vi.fn<HarnessResolver['resolve']>(() => effective);
    const s = setup(
      { resolve },
      { models: fixtureModel(), runtimeRecovery: { confirm: async () => {} } },
    );
    const result = s.start(writer(['first']), { mode: 'live' });
    expect(result.receipt.error).toBeUndefined();
    const { input, host } = await s.execution();
    expect(input.harness).toEqual(effective);
    await host.reportHarness!({
      ok: true,
      snapshotHash: effective.snapshotHash,
      tools: [],
      diagnostics: [],
    });
    const context = { messages: [{ role: 'user', content: 'Request', timestamp: 1 }] };
    const saved = await host.checkpointContext!({
      version: 1,
      piVersion: '1.3.0',
      runtime: 'pi-sdk',
      context,
      contextHash: sha256Hex(canonicalJson(context)),
    });
    expect(saved).toBeTruthy();
    const [preview] = await s.coordinator.runtimeCheckpoints(input.runId);
    expect(preview?.runtime).toBe('pi-sdk');
    expect(preview?.blockers).not.toContain('resources_changed');
    expect(preview?.blockers).toContain('source_not_stopped');
    resolve.mockReturnValue(snapshot(['second']));
    expect((await s.coordinator.runtimeCheckpoints(input.runId))[0]?.blockers).toContain(
      'resources_changed',
    );
    resolve.mockReturnValue(null);
    expect((await s.coordinator.runtimeCheckpoints(input.runId))[0]?.blockers).toContain(
      'resources_changed',
    );
    resolve.mockReturnValue(effective);
    expect((await s.coordinator.runtimeCheckpoints(input.runId))[0]?.blockers).not.toContain(
      'resources_changed',
    );
    s.stop.open();
    await s.ended.wait();
    const [settled] = await s.coordinator.runtimeCheckpoints(input.runId);
    expect(settled?.blockers).toContain('content_released');
    const resumed = await s.coordinator.resumeRuntime({
      commandId: 'resume',
      sourceRunId: input.runId,
      checkpointId: saved!.checkpointId,
      manifestHash: saved!.manifestHash,
      expectedSourceSeq: settled!.sourceSeq,
    });
    expect(resumed.runId).toBeNull();
    expect(resumed.receipt.error?.message).toContain('released');
    expect(s.store.listRuns()).toHaveLength(1);
  });
});
