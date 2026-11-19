import {
  type AgentHost,
  type AgentStartInput,
  type CorralDefinition,
  canonicalJson,
  type EffectiveHarnessSnapshot,
  ROLE_SKILLS_MINIMAL_BINDING,
  RoleHarnessResolutionError,
  type RoleMcpToolRef,
  type StartRunRequest,
} from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it, vi } from 'vitest';
import { Coordinator, type HarnessResolver, InMemoryRunStore, sha256Hex } from '../src/index.ts';
import { docsEcho, docsEdit, roleMcpCases } from './harness-role-mcp-cases.ts';

const bound = { profileId: 'work', revision: 2 };
const sessionId = 'session_fixture';
const denied = { runId: null, receipt: { error: { code: 'CAPABILITY_DENIED' } } };

function snapshot(names: string[], servers: string[]): EffectiveHarnessSnapshot {
  return {
    binding: bound,
    policy: 'trusted-native',
    piVersion: '1.3.0',
    policyRevision: 1,
    snapshotHash: sha256Hex(canonicalJson({ names, servers })),
    projectTools: {
      projectId: 'project',
      revision: 1,
      hash: sha256Hex('project'),
      mcpServerIds: servers,
      checkIds: [],
      lspServerIds: [],
    },
    allowedTools: ['submit_result', ...names],
    resources: [],
    tools: [],
    diagnostics: [],
  };
}

function worker(picks?: RoleMcpToolRef[], hasBinding = true) {
  const definition = linearCorral(['worker']);
  if (hasBinding) definition.roles[0]!.harness = bound;
  if (picks !== undefined) definition.roles[0]!.mcpTools = picks;
  return definition;
}

function setup(
  resolve?: HarnessResolver['resolve'],
  terminationMode: 'normal' | 'unconfirmed' = 'normal',
) {
  const store = new InMemoryRunStore();
  const clock = new FakeClock();
  const started = new Gate();
  const ended = new Gate();
  const stop = new Gate();
  let execution!: { host: AgentHost; input: AgentStartInput };
  const startAgent = vi.fn(async (input: AgentStartInput, host: AgentHost) => {
    execution = { input, host };
    started.open();
    return {
      cancel: async () => stop.open(),
      waitForSettlement: async () => {
        await stop.wait();
        return { outcome: 'cancelled' as const, terminationMode };
      },
    };
  });
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    store,
    agents: { start: startAgent },
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: { profile, provider: 'fixture', modelId: 'fixture', auth: 'api_key' },
      }),
    },
    ...(resolve ? { harnesses: { resolve, checkMcpTool: async () => {} } } : {}),
    onRunEnded: () => ended.open(),
    runtimeRecovery: { confirm: async () => {} },
  });
  return {
    store,
    stop,
    ended,
    startAgent,
    coordinator,
    start: (definition: CorralDefinition, options: Partial<StartRunRequest> = {}) =>
      coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'start',
        definition,
        mode: 'live',
        sessionId,
        ...options,
      }),
    execution: async () => {
      await started.wait();
      return execution;
    },
  };
}

describe('role MCP selection at run start', () => {
  it.each(roleMcpCases)('$title', async (row) => {
    const definition = worker(row.picks, row.binding !== 'none');
    const role = definition.roles[0]!;
    const effective = snapshot(row.offered ?? [], row.servers ?? []);
    if (row.binding === 'strict') effective.policy = 'strict';
    const resolve = vi.fn<HarnessResolver['resolve']>(() => {
      if (row.problem) {
        const error = new RoleHarnessResolutionError(null, {
          roleId: role.id,
          tools: row.picks!.map((ref) => ({ ...ref, reason: row.problem! })),
        });
        error.message = 'private resolver details: https://example.invalid/token?key=secret';
        throw error;
      }
      return effective;
    });
    const s = setup(resolve);
    const result = s.start(definition);
    const bypass = row.binding === 'none' && !row.picks?.length;
    if (bypass) expect(resolve).not.toHaveBeenCalled();
    else
      expect(resolve).toHaveBeenCalledExactlyOnceWith(
        role.harness,
        expect.objectContaining({ roles: [role] }),
        role.id,
        { sessionId },
      );
    if (row.problem) {
      expect(result).toMatchObject(denied);
      const message = result.receipt.error!.message;
      expect(message).toContain(role.id);
      expect(message).toContain('MCP');
      expect(message).toContain(row.problem);
      expect(message).not.toContain(row.picks![0]!.name);
      expect(message).not.toContain('secret');
      expect(s.startAgent).not.toHaveBeenCalled();
      expect(s.store.listRuns()).toEqual([]);
      return;
    }
    expect(result.receipt.error).toBeUndefined();
    const { input } = await s.execution();
    expect(input.role.mcpTools).toEqual(row.picks);
    expect(input.harness).toEqual(bypass ? undefined : effective);
    expect(s.store.getRun(input.runId)!.snapshot.harnesses).toEqual(
      bypass ? undefined : { [role.id]: effective },
    );
    s.stop.open();
  });

  it.each([
    { title: 'empty selection retaining a tool', picks: [], names: [docsEcho.name], servers: [] },
    { title: 'empty selection retaining a server', picks: [], names: [], servers: ['docs'] },
    {
      title: 'additional same-server tool',
      picks: [docsEcho],
      names: [docsEcho.name, docsEdit.name],
      servers: ['docs'],
    },
    {
      title: 'generic resource access',
      picks: [docsEcho],
      names: [docsEcho.name, 'read_mcp_resource'],
      servers: ['docs'],
    },
    {
      title: 'additional server',
      picks: [docsEcho],
      names: [docsEcho.name],
      servers: ['docs', 'other'],
    },
    {
      title: 'missing requested tool',
      picks: [docsEcho, docsEdit],
      names: [docsEcho.name],
      servers: ['docs'],
    },
    { title: 'missing requested server', picks: [docsEcho], names: [docsEcho.name], servers: [] },
  ])('rejects a mismatched resolver snapshot: $title', ({ picks, names, servers }) => {
    const s = setup(() => snapshot(names, servers));
    expect(s.start(worker(picks))).toMatchObject(denied);
    expect(s.startAgent).not.toHaveBeenCalled();
  });

  it.each([false, true])('refuses MCP under an implicit strict baseline (skills: %s)', (skills) => {
    const definition = worker([docsEcho], false);
    if (skills) definition.roles[0]!.skills = [];
    const s = setup(() => ({
      ...snapshot([docsEcho.name], ['docs']),
      binding: ROLE_SKILLS_MINIMAL_BINDING,
      policy: 'strict',
    }));
    expect(s.start(definition)).toMatchObject(denied);
    expect(s.store.listRuns()).toEqual([]);
  });

  it('keeps the skill-only baseline when the MCP list is empty', async () => {
    const definition = worker([], false);
    definition.roles[0]!.skills = [];
    const effective = {
      ...snapshot([], []),
      binding: ROLE_SKILLS_MINIMAL_BINDING,
      policy: 'strict' as const,
    };
    const s = setup(() => effective);
    expect(s.start(definition).receipt.error).toBeUndefined();
    expect((await s.execution()).input.harness).toEqual(effective);
    s.stop.open();
  });

  it('refuses meeting MCP picks but keeps an empty meeting selection off the SDK', () => {
    const meeting = { sessionId, roundId: 'round', participantId: 'worker' };
    const resolve = vi.fn(() => snapshot([docsEcho.name], ['docs']));
    const s = setup(resolve);
    expect(s.start(worker([docsEcho], false), { meeting })).toMatchObject(denied);
    expect(resolve).not.toHaveBeenCalled();
    const empty = s.start(worker([], false), { commandId: 'empty', meeting });
    expect(empty.receipt.error).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    s.stop.open();
  });

  it.each([{ picks: [] }, { picks: [docsEcho] }])('refuses observer picks: $picks', ({ picks }) => {
    const definition = linearCorral(['worker']);
    definition.roles.push({
      ...definition.roles[0]!,
      id: 'observer_role',
      harness: bound,
      mcpTools: picks,
      allowedWorkTools: [],
      allowedCollaborationTools: [],
    });
    definition.nodes.push({
      id: 'observer',
      type: 'agent',
      invocation: 'observer',
      roleId: 'observer_role',
      label: 'Outrider',
      outputName: 'notes',
    });
    definition.capabilityLinks.push({
      id: 'watch',
      kind: 'advise',
      sourceNodeId: 'observer',
      targetNodeId: 'worker',
    });
    const resolve = vi.fn(() =>
      snapshot(
        picks.map((p) => p.name),
        picks.length ? ['docs'] : [],
      ),
    );
    const s = setup(resolve);
    expect(s.start(definition)).toMatchObject(denied);
    expect(resolve).not.toHaveBeenCalled();
    expect(s.startAgent).not.toHaveBeenCalled();
  });

  it('gives shared Outriders no worker MCP picks and checks the worker’s ask grant', async () => {
    const definition = worker([docsEcho]);
    definition.sharedOutrider = {
      modelProfile: 'model-a',
      principles: 'Answer questions.',
      targets: { kind: 'all' },
    };
    const resolve = vi.fn(() => snapshot([docsEcho.name], ['docs']));
    const s = setup(resolve);
    expect(s.start(definition).receipt.error).toBeUndefined();
    const { input } = await s.execution();
    expect(input.capabilities.askTo).toEqual([]);
    const pinned = s.store.getRun(input.runId)!.snapshot;
    const node = pinned.definition.nodes.find((n) => pinned.sharedOutriderNodeIds?.includes(n.id));
    if (node?.type !== 'agent') throw new Error('missing shared Outrider');
    expect(pinned.definition.roles.find((r) => r.id === node.roleId)?.mcpTools).toBeUndefined();
    expect(pinned.harnesses?.[node.roleId]).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
    s.stop.open();
  });

  it('a role with [] cannot call a tool selected by another role in the same run', async () => {
    const definition = linearCorral(['writer', 'researcher']);
    for (const role of definition.roles) role.harness = bound;
    definition.roles[0]!.mcpTools = [];
    definition.roles[1]!.mcpTools = [docsEcho];
    const empty = snapshot([], []);
    const picked = snapshot([docsEcho.name], ['docs']);
    const s = setup((_binding, _team, id) => (id === 'writer_role' ? empty : picked));
    expect(s.start(definition).receipt.error).toBeUndefined();
    const { host, input } = await s.execution();
    expect(s.store.getRun(input.runId)!.snapshot.harnesses).toEqual({
      writer_role: empty,
      researcher_role: picked,
    });
    await host.reportHarness!({
      ok: true,
      snapshotHash: empty.snapshotHash,
      tools: [],
      diagnostics: [],
    });
    const call = await host.authorizeTool({ name: docsEcho.name, args: {} });
    expect(call.ok).toBe(false);
    expect(s.store.readEvents(input.runId, 0)).toContainEqual(
      expect.objectContaining({
        type: 'tool.blocked',
        executionId: input.executionId,
        payload: expect.objectContaining({ toolCallId: call.toolCallId }),
      }),
    );
    s.stop.open();
  });

  it('rejects a changed MCP grant under an unchanged checkpoint hash', async () => {
    const effective = snapshot([], []);
    effective.policy = 'strict';
    const resolve = vi.fn(() => effective);
    const s = setup(resolve);
    expect(s.start(worker([])).receipt.error).toBeUndefined();
    const { host, input } = await s.execution();
    await host.reportHarness!({
      ok: true,
      snapshotHash: effective.snapshotHash,
      tools: [],
      diagnostics: [],
    });
    const context = { messages: [{ role: 'user', content: 'Request', timestamp: 1 }] };
    const saved = await host.checkpointContext!({
      version: 1,
      runtime: 'pi-sdk',
      piVersion: '1.3.0',
      context,
      contextHash: sha256Hex(canonicalJson(context)),
    });
    expect(saved).toBeTruthy();
    const [before] = await s.coordinator.runtimeCheckpoints(input.runId);
    expect(before!.blockers).not.toContain('resources_changed');
    resolve.mockReturnValue({ ...effective, allowedTools: [docsEcho.name] });
    const [after] = await s.coordinator.runtimeCheckpoints(input.runId);
    expect(after!.blockers).toContain('resources_changed');
    s.stop.open();
  });

  it.each(['normal', 'unconfirmed'] as const)('records MCP stop: %s', async (terminationMode) => {
    const effective = snapshot([docsEcho.name], ['docs']);
    const s = setup(() => effective, terminationMode);
    expect(s.start(worker([docsEcho])).receipt.error).toBeUndefined();
    const { host, input } = await s.execution();
    await host.reportHarness!({
      ok: true,
      snapshotHash: effective.snapshotHash,
      tools: [
        {
          source: 'extension:pi-mcp@1.3.0',
          name: docsEcho.name,
          schemaHash: sha256Hex('echo'),
          exposure: 'direct',
          sideEffect: 'none',
          annotations: { readOnlyHint: true },
        },
      ],
      diagnostics: [],
    });
    const call = await host.authorizeTool({ name: docsEcho.name, args: {} });
    expect(call.ok).toBe(true);
    await host.beginNativeTool!(call.toolCallId, sha256Hex(canonicalJson({})));
    const effectId = s.store.getRun(input.runId)!.projection.toolCalls[call.toolCallId]!.effectId;
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'stop',
      runId: input.runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    await s.ended.wait();
    await expect(host.finishNativeTool!(call.toolCallId, 'succeeded')).rejects.toThrow();
    const events = s.store.readEvents(input.runId, 0);
    const settled = events.filter(
      (e) => e.type === 'effect.settled' && e.payload.effectId === effectId,
    );
    const finished = events.filter(
      (e) => e.type === 'tool.finished' && e.payload.toolCallId === call.toolCallId,
    );
    if (terminationMode === 'normal') {
      expect(settled).toMatchObject([{ payload: { outcome: 'cancelled' } }]);
      expect(finished).toMatchObject([{ payload: { resultRef: null, error: 'cancelled' } }]);
    } else {
      expect(settled).toMatchObject([{ payload: { outcome: 'unknown' } }]);
      expect(finished).toEqual([]);
    }
  });
});
