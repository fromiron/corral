import {
  type AgentHost,
  type AgentStartInput,
  type CheckPlan,
  type CommandPlan,
  canonicalJson,
  type EffectiveHarnessSnapshot,
  type LspReport,
  type ModelRequestRecord,
  type PermissionMode,
  type ToolDescriptor,
  type VerificationReport,
} from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import {
  Coordinator,
  exportRunArchive,
  type FileTools,
  InMemoryRunStore,
  openRunArchive,
  ToolTerminationUnconfirmed,
} from '../src/index.ts';

const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
const descriptor: ToolDescriptor = {
  name: 'echo',
  source: 'extension:fixture@1.0.0',
  schemaHash: 'b'.repeat(64),
  exposure: 'direct',
  sideEffect: 'none',
  annotations: { readOnlyHint: true, openWorldHint: false },
};
const snapshot: EffectiveHarnessSnapshot = {
  binding: { profileId: 'writing', revision: 1 },
  snapshotHash: 'a'.repeat(64),
  piVersion: '1.3.0',
  policyRevision: 1,
  policy: 'trusted-native',
  resources: [
    { hash: 'c'.repeat(64), name: 'fixture', version: '1.0.0', kind: 'extension', required: true },
  ],
  allowedTools: ['echo'],
  tools: [],
  diagnostics: [],
};
const record: ModelRequestRecord = {
  purpose: 'turn',
  directiveIds: [],
  contextHash: 'd'.repeat(64),
  contextBytes: 250,
  sections: [],
};
function setup(
  resolve = true,
  selected = snapshot,
  options: {
    files?: FileTools;
    fileTools?: boolean;
    plans?: boolean;
    reviewOnly?: boolean;
    isolation?: boolean;
    permissionMode?: PermissionMode;
    commandTools?: boolean;
    harness?: Partial<NonNullable<ConstructorParameters<typeof Coordinator>[0]['harnesses']>>;
  } = {},
) {
  const started = new Gate();
  const done = new Gate();
  const store = new InMemoryRunStore();
  const clock = new FakeClock();
  let host!: AgentHost;
  let input!: AgentStartInput;
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    store,
    ...(options.isolation
      ? {
          models: {
            resolve: (profile: string) => ({
              ok: true as const,
              snapshot: {
                profile,
                provider: null,
                modelId: null,
                auth: 'mock' as const,
                workerIsolation: 'linux-bwrap' as const,
              },
            }),
          },
        }
      : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(resolve
      ? {
          harnesses: {
            resolve: () => JSON.parse(JSON.stringify(selected)) as EffectiveHarnessSnapshot,
            readSkill: () => ({ text: 'first\nsecond\nthird', sha256: 'e'.repeat(64) }),
            ...options.harness,
          },
        }
      : {}),
    agents: {
      start: async (i, h) => {
        input = i;
        host = h;
        started.open();
        return {
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' as const };
          },
        };
      },
    },
  });
  const definition = linearCorral(['writer']);
  definition.roles[0]!.harness = snapshot.binding;
  if (options.reviewOnly) definition.input.taskScope = 'review_only';
  if (options.plans) definition.roles[0]!.allowedCollaborationTools.push('update_plan');
  if (options.fileTools) definition.roles[0]!.allowedWorkTools = ['read_file', 'write_file'];
  if (options.commandTools) definition.roles[0]!.allowedWorkTools.push('run_command');
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition,
    mode: 'mock',
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
  });
  return {
    coordinator,
    clock,
    store,
    result,
    started,
    done,
    host: () => host,
    input: () => input,
    events: () => store.readEvents(result.runId!, 0),
  };
}
async function loaded() {
  const s = setup();
  await s.started.wait();
  await s.host().reportHarness!({
    ok: true,
    snapshotHash: snapshot.snapshotHash,
    tools: [descriptor],
    diagnostics: [],
  });
  return s;
}

describe('worktree command and preset Coordinator path (ABS-01/02)', () => {
  const commandDescriptor: ToolDescriptor = {
    ...descriptor,
    source: 'corral',
    name: 'run_command',
    sideEffect: 'external',
  };
  const plan: CommandPlan = {
    operationId: 'operation_one',
    hostId: 'local',
    sessionId: 'session_one',
    workspaceBindingId: 'workspace_one',
    worktreeId: 'worktree_one',
    rootIdentity: 'c'.repeat(64),
    tree: 'd'.repeat(40),
    shellId: 'powershell',
    executable: 'powershell.exe',
    argv: ['-Command', 'echo hello'],
    cwd: '.',
    environmentHash: 'e'.repeat(64),
    timeoutMs: 10000,
    fingerprint: 'f'.repeat(64),
  };
  async function commandSetup(
    mode: PermissionMode,
    reviewOnly = false,
    strict = false,
    service?: { stop: () => Promise<void> },
  ) {
    const acquireRun = vi.fn<NonNullable<FileTools['acquireRun']>>(() => {});
    const runCommand = vi.fn<NonNullable<FileTools['runCommand']>>(async () => ({
      operationId: plan.operationId,
      state: service ? ('running' as const) : ('completed' as const),
      exitCode: service ? null : 0,
      signal: null,
      timedOut: false,
      cleanupConfirmed: !service,
      output: { text: 'hello', bytes: 5, hash: 'a'.repeat(64), truncated: false },
    }));
    const selected = {
      ...snapshot,
      policy: strict ? ('strict' as const) : ('trusted-native' as const),
      resources: [],
      allowedTools: service ? ['run_command', 'write_artifact', 'submit_result'] : ['run_command'],
    };
    const s = setup(true, selected, {
      permissionMode: mode,
      commandTools: true,
      reviewOnly,
      files: {
        acquireRun,
        available: () => true,
        execute: async () => ({}),
        planCommand: async () => ({ ...plan, mode: service ? 'service' : 'foreground' }),
        runCommand,
        ...(service ? { stopRunServices: service.stop } : {}),
      },
    });
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: [
        commandDescriptor,
        ...(service
          ? [
              { ...commandDescriptor, name: 'write_artifact', sideEffect: 'workspace' as const },
              { ...commandDescriptor, name: 'submit_result', sideEffect: 'workspace' as const },
            ]
          : []),
      ],
      diagnostics: [],
    });
    return { ...s, runCommand, acquireRun };
  }
  it('[TC-ABS-001-N] cancellation does not finish before run-owned services confirm cleanup', async () => {
    const stopped = new Gate();
    const stop = vi.fn(() => stopped.wait());
    const s = await commandSetup('auto', false, false, { stop });
    expect(
      (
        await s
          .host()
          .invokeTool({ name: 'run_command', args: { command: 'serve', mode: 'service' } })
      ).ok,
    ).toBe(true);
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'stop_service',
      runId: s.input().runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop work' },
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(s.coordinator.getSnapshot(s.input().runId).projection.status).toBe('cancelling');
    stopped.open();
    await vi.waitFor(() =>
      expect(s.coordinator.getSnapshot(s.input().runId).projection.status).toBe('cancelled'),
    );
  });

  it('[TC-ABS-001-N] uncertain service shutdown fails the Run instead of confirming cancellation', async () => {
    const s = await commandSetup('auto', false, false, {
      stop: async () => {
        throw new ToolTerminationUnconfirmed();
      },
    });
    expect(
      (
        await s
          .host()
          .invokeTool({ name: 'run_command', args: { command: 'serve', mode: 'service' } })
      ).ok,
    ).toBe(true);
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'stop_uncertain',
      runId: s.input().runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop work' },
    });
    await vi.waitFor(() =>
      expect(s.coordinator.getSnapshot(s.input().runId).projection.status).toBe('failed'),
    );
    expect(s.events().some((event) => event.type === 'cancel.confirmed')).toBe(false);
  });
  it('[TC-ABS-001-N] pause waits for services before declaring the safe boundary', async () => {
    const stopped = new Gate();
    const stop = vi.fn(() => stopped.wait());
    const s = await commandSetup('auto', false, false, { stop });
    expect(
      (
        await s
          .host()
          .invokeTool({ name: 'run_command', args: { command: 'serve', mode: 'service' } })
      ).ok,
    ).toBe(true);
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'pause_service',
      runId: s.input().runId,
      type: 'pause',
      payload: { scope: 'run' },
    });
    const waiting = s
      .host()
      .prepareModelRequest(record)
      .catch(() => null);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(s.coordinator.getSnapshot(s.input().runId).projection.status).toBe('pausing');
    stopped.open();
    await vi.waitFor(() =>
      expect(s.coordinator.getSnapshot(s.input().runId).projection.status).toBe('paused'),
    );
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel_paused_service',
      runId: s.input().runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'finish test' },
    });
    await waiting;
    await vi.waitFor(() =>
      expect(s.coordinator.getSnapshot(s.input().runId).projection.status).toBe('cancelled'),
    );
  });
  it('[TC-ABS-001-H] output success waits until its service has actually stopped', async () => {
    const stopped = new Gate();
    const stop = vi.fn(() => stopped.wait());
    const s = await commandSetup('auto', false, false, { stop });
    expect(
      (
        await s
          .host()
          .invokeTool({ name: 'run_command', args: { command: 'serve', mode: 'service' } })
      ).ok,
    ).toBe(true);
    const written = await s
      .host()
      .invokeTool({ name: 'write_artifact', args: { text: 'Completed work' } });
    if (!written.ok) throw new Error(written.error.message);
    expect(
      (
        await s.host().invokeTool({
          name: 'submit_result',
          args: { artifactVersionIds: [written.result.artifactVersionId] },
        })
      ).ok,
    ).toBe(true);
    s.done.open();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(s.coordinator.getSnapshot(s.input().runId).projection.status).not.toBe('succeeded');
    stopped.open();
    await vi.waitFor(() =>
      expect(s.coordinator.getSnapshot(s.input().runId).projection.status).toBe('succeeded'),
    );
  });
  it('[TC-ABS-001-H] asks once using resolved launch identity and duplicate execution cannot spawn twice', async () => {
    const s = await commandSetup('ask');
    const auth = await s
      .host()
      .authorizeTool({ name: 'run_command', args: { command: 'echo hello' } });
    expect(auth.ok).toBe(true);
    const pending = s.host().executeTool(auth.toolCallId);
    await vi.waitFor(() =>
      expect(s.events().filter((e) => e.type === 'approval.requested')).toHaveLength(1),
    );
    expect(s.runCommand).not.toHaveBeenCalled();
    const approval = s.events().find((e) => e.type === 'approval.requested')!;
    if (approval.type !== 'approval.requested') throw new Error('approval missing');
    const body = s.store.getArtifactText(s.input().runId, approval.payload.subjectVersionIds[0]!);
    expect(JSON.parse(body!).arguments).toEqual({
      ...plan,
      mode: 'foreground',
      request: { command: 'echo hello' },
    });
    expect(
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'approve_command',
        runId: s.input().runId,
        type: 'resolve_approval',
        expectedControlRevision: s.coordinator.getSnapshot(s.input().runId).projection
          .controlRevision,
        payload: {
          approvalId: approval.payload.approvalId,
          decision: 'approve',
          subjectVersionId: approval.payload.subjectVersionIds[0]!,
        },
      }).status,
    ).toBe('applied');
    expect((await pending).ok).toBe(true);
    expect((await s.host().executeTool(auth.toolCallId)).ok).toBe(false);
    expect(s.runCommand).toHaveBeenCalledTimes(1);
    expect(s.runCommand.mock.calls[0]).toMatchObject([
      { request: { command: 'echo hello' }, attemptNo: 1 },
      plan,
      plan.fingerprint,
      { aborted: false, onCancel: expect.any(Function) },
    ]);
    expect(s.coordinator.getRunSnapshot(s.input().runId)?.permissionMode).toBe('ask');
    s.done.open();
  });
  it('[TC-ABS-002-H] Auto runs an admitted command without extra approval', async () => {
    const s = await commandSetup('auto');
    const auth = await s
      .host()
      .authorizeTool({ name: 'run_command', args: { command: 'echo hello' } });
    expect((await s.host().executeTool(auth.toolCallId)).ok).toBe(true);
    expect(s.events().filter((e) => e.type === 'approval.requested')).toHaveLength(0);
    s.done.open();
  });
  it('[TC-ABS-001-N] cancellation closes the pending launch and a late approval cannot execute it', async () => {
    const s = await commandSetup('accept_edits');
    const auth = await s
      .host()
      .authorizeTool({ name: 'run_command', args: { command: 'echo hello' } });
    const pending = s.host().executeTool(auth.toolCallId);
    await vi.waitFor(() =>
      expect(s.events().some((e) => e.type === 'approval.requested')).toBe(true),
    );
    const event = s.events().find((e) => e.type === 'approval.requested');
    if (!event || event.type !== 'approval.requested') throw new Error('missing approval');
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel_command',
      runId: s.input().runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'cancel launch' },
    });
    expect((await pending).ok).toBe(false);
    expect(s.runCommand).not.toHaveBeenCalled();
    const finished = s
      .events()
      .find(
        (event) => event.type === 'tool.finished' && event.payload.toolCallId === auth.toolCallId,
      );
    expect(finished?.payload).toMatchObject({ error: null });
    const started = s
      .events()
      .find(
        (event) => event.type === 'tool.started' && event.payload.toolCallId === auth.toolCallId,
      );
    if (!started || started.type !== 'tool.started') throw new Error('missing command effect');
    expect(
      s
        .events()
        .find(
          (event) =>
            event.type === 'effect.settled' && event.payload.effectId === started.payload.effectId,
        )?.payload,
    ).toMatchObject({ outcome: 'cancelled' });
    const late = s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'late_command',
      runId: s.input().runId,
      type: 'resolve_approval',
      expectedControlRevision: s.coordinator.getSnapshot(s.input().runId).projection
        .controlRevision,
      payload: {
        approvalId: event.payload.approvalId,
        decision: 'approve',
        subjectVersionId: event.payload.subjectVersionIds[0]!,
      },
    });
    expect(late.status).toBe('rejected');
    expect(s.runCommand).not.toHaveBeenCalled();
    s.done.open();
  });
  it.each([
    ['cancelled', true, false, 'cancelled'],
    ['failed', true, false, 'failed'],
    ['cancelled', true, true, 'failed'],
    ['uncertain', false, false, 'unknown'],
  ] as const)(
    '[TC-ABS-001-N] cancellation preserves process %s / cleanup %s / timeout %s as %s',
    async (state, cleanupConfirmed, timedOut, outcome) => {
      const s = await commandSetup('auto');
      const entered = new Gate();
      s.runCommand.mockImplementation(async (_input, _plan, _approved, cancellation) => {
        entered.open();
        await new Promise<void>((resolve) => cancellation.onCancel(resolve));
        return {
          operationId: plan.operationId,
          state,
          exitCode: state === 'failed' ? 9 : null,
          signal: null,
          timedOut,
          cleanupConfirmed,
          output: { text: '', bytes: 0, hash: 'a'.repeat(64), truncated: false },
        };
      });
      const auth = await s
        .host()
        .authorizeTool({ name: 'run_command', args: { command: 'long task' } });
      const pending = s.host().executeTool(auth.toolCallId);
      await entered.wait();
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'cancel_process',
        runId: s.input().runId,
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason: 'user stopped work' },
      });
      expect((await pending).ok).toBe(false);
      const started = s
        .events()
        .find(
          (event) => event.type === 'tool.started' && event.payload.toolCallId === auth.toolCallId,
        );
      if (!started || started.type !== 'tool.started') throw new Error('missing command effect');
      expect(
        s
          .events()
          .find(
            (event) =>
              event.type === 'effect.settled' &&
              event.payload.effectId === started.payload.effectId,
          )?.payload,
      ).toMatchObject({ outcome });
      if (outcome === 'cancelled')
        expect(
          s
            .events()
            .find(
              (event) =>
                event.type === 'tool.finished' && event.payload.toolCallId === auth.toolCallId,
            )?.payload,
        ).toMatchObject({ error: null });
      s.done.open();
    },
  );
  it('[TC-ABS-001-N] a Coordinator tool timeout remains failed even when process cancellation confirms cleanup', async () => {
    const s = await commandSetup('auto');
    const entered = new Gate();
    s.runCommand.mockImplementation(async (_input, _plan, _approved, cancellation) => {
      entered.open();
      await new Promise<void>((resolve) => cancellation.onCancel(resolve));
      return {
        operationId: plan.operationId,
        state: 'cancelled',
        exitCode: null,
        signal: null,
        timedOut: false,
        cleanupConfirmed: true,
        output: { text: '', bytes: 0, hash: 'a'.repeat(64), truncated: false },
      };
    });
    const auth = await s
      .host()
      .authorizeTool({ name: 'run_command', args: { command: 'long task' } });
    const pending = s.host().executeTool(auth.toolCallId);
    await entered.wait();
    s.clock.advance(plan.timeoutMs + 120000);
    expect((await pending).ok).toBe(false);
    const started = s
      .events()
      .find(
        (event) => event.type === 'tool.started' && event.payload.toolCallId === auth.toolCallId,
      );
    if (!started || started.type !== 'tool.started') throw new Error('missing command effect');
    expect(
      s
        .events()
        .find(
          (event) =>
            event.type === 'effect.settled' && event.payload.effectId === started.payload.effectId,
        )?.payload,
    ).toMatchObject({ outcome: 'failed' });
    expect(
      s
        .events()
        .find(
          (event) => event.type === 'tool.finished' && event.payload.toolCallId === auth.toolCallId,
        )?.payload,
    ).toMatchObject({ error: 'tool timed out' });
    s.done.open();
  });
  it('[TC-ABS-002-N] changed registration invalidates a pending command grant', async () => {
    const s = await commandSetup('ask');
    const auth = await s
      .host()
      .authorizeTool({ name: 'run_command', args: { command: 'echo hello' } });
    const pending = s.host().executeTool(auth.toolCallId);
    await vi.waitFor(() =>
      expect(s.events().some((e) => e.type === 'approval.requested')).toBe(true),
    );
    const event = s.events().find((e) => e.type === 'approval.requested');
    if (!event || event.type !== 'approval.requested') throw new Error('missing approval');
    await s.host().updateHarnessTools!({
      snapshotHash: snapshot.snapshotHash,
      expectedRevision: 1,
      tools: [{ ...commandDescriptor, schemaHash: 'e'.repeat(64) }],
    });
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'changed_command',
      runId: s.input().runId,
      type: 'resolve_approval',
      expectedControlRevision: s.coordinator.getSnapshot(s.input().runId).projection
        .controlRevision,
      payload: {
        approvalId: event.payload.approvalId,
        decision: 'approve',
        subjectVersionId: event.payload.subjectVersionIds[0]!,
      },
    });
    expect((await pending).ok).toBe(false);
    expect(s.runCommand).not.toHaveBeenCalled();
    s.done.open();
  });
  it('[TC-ABS-002-N] Auto cannot turn review-only or strict into command capability', async () => {
    for (const [reviewOnly, strict] of [
      [true, false],
      [false, true],
    ]) {
      const s = await commandSetup('auto', reviewOnly, strict);
      if (reviewOnly) expect(s.acquireRun.mock.calls[0]?.[2]).toBe(false);
      const auth = await s
        .host()
        .authorizeTool({ name: 'run_command', args: { command: 'echo hello' } });
      expect(auth.ok).toBe(false);
      expect(s.runCommand).not.toHaveBeenCalled();
      s.done.open();
    }
  });
});

describe('Coordinator harness boundary (H2)', () => {
  it('[TC-SBX-002-N] isolated model profiles cannot launch native harnesses or host command recipes', () => {
    const native = setup(true, snapshot, { isolation: true });
    expect(native.result.runId).toBeNull();
    const command = setup(
      true,
      {
        ...snapshot,
        policy: 'strict',
        resources: [],
        allowedTools: ['run_check'],
        projectTools: {
          projectId: 'default',
          revision: 1,
          hash: 'c'.repeat(64),
          checkIds: ['types'],
          lspServerIds: [],
        },
      },
      { isolation: true },
    );
    command.done.open();
    expect(command.result.runId).toBeNull();
  });

  it('[TC-HAR-003-N] simulation cannot fabricate an SDK load or provider payload record', async () => {
    const s = setup();
    await s.started.wait();
    await s.host().simulateHarness!();
    await expect(
      s.host().reportHarness!({
        ok: true,
        snapshotHash: snapshot.snapshotHash,
        tools: [descriptor],
        diagnostics: [],
      }),
    ).rejects.toThrow();
    await expect(s.host().prepareModelRequest(record)).rejects.toThrow(/simulation/);
    const permit = await s.host().prepareModelRequest();
    await expect(
      s.host().recordProviderPayload!({
        modelCallId: permit.modelCallId,
        payloadHash: 'e'.repeat(64),
        payloadBytes: 10,
      }),
    ).rejects.toThrow(/simulation/);
    expect(
      s
        .events()
        .some(
          (e) =>
            e.type === 'harness.loaded' ||
            e.type === 'model.request_recorded' ||
            e.type === 'model.payload_recorded',
        ),
    ).toBe(false);
    s.done.open();
  });
  it('[TC-HAR-017-N] the worker capacity is shared by distinct executions', async () => {
    const started = new Gate(),
      childrenReady = new Gate(),
      done = new Gate();
    const hosts: { input: AgentStartInput; host: AgentHost }[] = [];
    const chosen = { ...snapshot, resources: [], allowedTools: ['codemode', 'spawn_subagents'] };
    const clock = new FakeClock();
    const coordinator = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      harnesses: { resolve: () => chosen },
      agents: {
        start: async (input, host) => {
          hosts.push({ input, host });
          started.open();
          if (hosts.length === 4) childrenReady.open();
          return {
            cancel: async () => done.open(),
            waitForSettlement: async () => {
              await done.wait();
              return { outcome: 'cancelled' };
            },
          };
        },
      },
    });
    const definition = linearCorral(['writer']);
    definition.roles[0]!.harness = snapshot.binding;

    definition.roles[0]!.allowedCollaborationTools.push('spawn_subagents');
    const writer = definition.nodes.find((n) => n.type === 'agent')!;
    definition.nodes.push({ ...writer, id: 'helper', invocation: 'callable' });
    definition.capabilityLinks.push({
      id: 'delegate',
      kind: 'delegate',
      sourceNodeId: 'writer',
      targetNodeId: 'helper',
    });
    coordinator.startRun({ schemaVersion: '0.1', commandId: 'capacity', definition, mode: 'mock' });
    await started.wait();
    const report = {
      ok: true as const,
      snapshotHash: snapshot.snapshotHash,
      tools: [
        { ...descriptor, name: 'codemode', source: 'extension:pi-codemode@1.3.0' },
        { ...descriptor, name: 'spawn_subagents', source: 'corral' },
      ],
      diagnostics: [],
    };
    await hosts[0]!.host.reportHarness!(report);
    expect(
      (
        await hosts[0]!.host.invokeTool({
          name: 'spawn_subagents',
          args: { tasks: [1, 2, 3].map((n) => ({ targetNodeId: 'helper', brief: String(n) })) },
        })
      ).ok,
    ).toBe(true);
    await childrenReady.wait();
    const calls = [];
    for (const child of hosts.slice(1)) {
      await child.host.reportHarness!(report);
      calls.push({
        host: child.host,
        ...(await child.host.authorizeTool({ name: 'codemode', args: { code: 'text(1)' } })),
      });
    }
    await calls[0]!.host.beginNativeTool!(calls[0]!.toolCallId, hash({ code: 'text(1)' }));
    await calls[1]!.host.beginNativeTool!(calls[1]!.toolCallId, hash({ code: 'text(1)' }));
    await expect(
      calls[2]!.host.beginNativeTool!(calls[2]!.toolCallId, hash({ code: 'text(1)' })),
    ).rejects.toThrow(/capacity/);
    await calls[0]!.host.finishNativeTool!(calls[0]!.toolCallId, 'succeeded');
    await calls[2]!.host.beginNativeTool!(calls[2]!.toolCallId, hash({ code: 'text(1)' }));
    done.open();
  });
  it('[TC-HAR-016-N] rechecks MCP trust at dispatch and credentials only for selected owned execution', async () => {
    let trusted = true;
    const authorization = vi.fn(async () => 'fixture-token');
    const s = setup(
      true,
      {
        ...snapshot,
        resources: [],
        allowedTools: ['mcp__docs__echo'],
        projectTools: {
          projectId: 'p',
          revision: 1,
          hash: 'a'.repeat(64),
          checkIds: [],
          lspServerIds: [],
          mcpServerIds: ['docs'],
        },
      },
      {
        harness: {
          checkMcpTool: async () => {
            if (!trusted) throw new Error('revoked');
          },
          mcpAuthorization: authorization,
        },
      },
    );
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: snapshot.snapshotHash,
      tools: [{ ...descriptor, name: 'mcp__docs__echo', source: 'extension:pi-mcp@1.3.0' }],
      diagnostics: [],
    });
    expect(await s.host().mcpAuthorization!('docs')).toBe('fixture-token');
    await expect(s.host().mcpAuthorization!('unknown')).rejects.toThrow();
    expect(authorization).toHaveBeenCalledTimes(1);
    const call = await s.host().authorizeTool({ name: 'mcp__docs__echo', args: {} });
    expect(call.ok).toBe(true);
    trusted = false;
    await expect(s.host().beginNativeTool!(call.toolCallId, hash({}))).rejects.toThrow('revoked');
    trusted = true;
    await s.host().beginNativeTool!(call.toolCallId, hash({}));
    await s.host().finishNativeTool!(call.toolCallId, 'succeeded');
    s.done.open();
  });
  it('[TC-HAR-017-N] grants at most two codemode capacities and frees only an owned completion', async () => {
    const s = setup(true, { ...snapshot, resources: [], allowedTools: ['codemode'] });
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: snapshot.snapshotHash,
      tools: [{ ...descriptor, name: 'codemode', source: 'extension:pi-codemode@1.3.0' }],
      diagnostics: [],
    });
    const calls = [];
    for (let n = 0; n < 3; n++)
      calls.push(await s.host().authorizeTool({ name: 'codemode', args: { code: 'text(1)' } }));
    await s.host().beginNativeTool!(calls[0]!.toolCallId, hash({ code: 'text(1)' }));
    await s.host().beginNativeTool!(calls[1]!.toolCallId, hash({ code: 'text(1)' }));
    await expect(
      s.host().beginNativeTool!(calls[2]!.toolCallId, hash({ code: 'text(1)' })),
    ).rejects.toThrow(/capacity/i);
    await s.host().finishNativeTool!(calls[0]!.toolCallId, 'succeeded');
    await expect(s.host().finishNativeTool!(calls[0]!.toolCallId, 'succeeded')).rejects.toThrow();
    await s.host().beginNativeTool!(calls[2]!.toolCallId, hash({ code: 'text(1)' }));
    s.done.open();
  });
  it('[TC-HAR-017-N] closing a parent cancels an already running nested broker call', async () => {
    const entered = new Gate();
    let cancelled = false;
    const files: FileTools = {
      available: () => true,
      execute: async (_input, signal) => {
        entered.open();
        await new Promise<void>((resolve) =>
          signal.onCancel(() => {
            cancelled = signal.aborted;
            resolve();
          }),
        );
        throw new Error('cancelled');
      },
    };
    const s = setup(
      true,
      { ...snapshot, allowedTools: ['echo', 'read_file'] },
      { files, fileTools: true },
    );
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: snapshot.snapshotHash,
      tools: [descriptor, { ...descriptor, name: 'read_file', source: 'corral' }],
      diagnostics: [],
    });
    const parent = await s.host().authorizeTool({ name: 'echo', args: { text: 'parent' } });
    await s.host().beginNativeTool!(parent.toolCallId, hash({ text: 'parent' }));
    const child = s.host().invokeTool({
      name: 'read_file',
      args: { path: 'a.txt' },
      parentToolCallId: parent.toolCallId,
    });
    await entered.wait();
    await s.host().finishNativeTool!(parent.toolCallId, 'succeeded');
    expect(cancelled).toBe(true);
    expect(await child).toMatchObject({ ok: false });
    s.done.open();
  });
  it('[TC-HAR-017-N] nested calls require a live native parent and cannot execute after it closes', async () => {
    const s = await loaded();
    expect(
      await s
        .host()
        .authorizeTool({ name: 'echo', args: { text: 'child' }, parentToolCallId: 'unknown' }),
    ).toMatchObject({ ok: false });
    const parent = await s.host().authorizeTool({ name: 'echo', args: { text: 'parent' } });
    await s.host().beginNativeTool!(parent.toolCallId, hash({ text: 'parent' }));
    const child = await s.host().authorizeTool({
      name: 'echo',
      args: { text: 'child' },
      parentToolCallId: parent.toolCallId,
    });
    expect(child.ok).toBe(true);
    expect(
      s
        .events()
        .find((e) => e.type === 'tool.requested' && e.payload.toolCallId === child.toolCallId)
        ?.payload,
    ).toMatchObject({ parentToolCallId: parent.toolCallId });
    await s.host().finishNativeTool!(parent.toolCallId, 'succeeded');
    await expect(
      s.host().beginNativeTool!(child.toolCallId, hash({ text: 'child' })),
    ).rejects.toThrow();
    s.done.open();
  });
  it('[TC-HAR-016-N] revisions dynamic descriptors and refuses old approvals, duplicate updates and unbound sources', async () => {
    const s = await loaded();
    const approved = await s.host().authorizeTool({ name: 'echo', args: { text: 'hello' } });
    expect(approved.ok).toBe(true);
    const updated = { ...descriptor, schemaHash: 'f'.repeat(64) };
    const update = { snapshotHash: snapshot.snapshotHash, expectedRevision: 1, tools: [updated] };
    await s.host().updateHarnessTools!(update);
    await expect(s.host().updateHarnessTools!(update)).rejects.toThrow(/revision/i);
    await expect(
      s.host().beginNativeTool!(approved.toolCallId, hash({ text: 'hello' })),
    ).rejects.toThrow();
    const next = await s.host().authorizeTool({ name: 'echo', args: { text: 'hello' } });
    expect(next.ok).toBe(true);
    await s.host().beginNativeTool!(next.toolCallId, hash({ text: 'hello' }));
    await s.host().finishNativeTool!(next.toolCallId, 'succeeded');
    await expect(
      s.host().updateHarnessTools!({
        ...update,
        expectedRevision: 2,
        tools: [{ ...updated, source: 'extension:unbound@1.0.0' }],
      }),
    ).rejects.toThrow(/unbound/i);
    expect(s.events().filter((e) => e.type === 'harness.tools_updated')).toHaveLength(1);
    s.done.open();
  });
  it('[TC-HAR-003-H] pins a run-only harness layer and refuses unknown or unbound role overrides', () => {
    const definition = linearCorral(['writer']);
    const role = definition.roles[0]!;
    role.harness = snapshot.binding;
    const override = { profileId: 'narrow', revision: 2 };
    const selected = {
      ...snapshot,
      resources: [],
      layers: [
        { scope: 'role' as const, binding: snapshot.binding },
        { scope: 'run' as const, binding: override },
      ],
    };
    const resolve = vi.fn(() => selected);
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      harnesses: { resolve },
      agents: {
        start: async () => {
          throw new Error('not exercised');
        },
      },
    });
    const request = {
      schemaVersion: '0.1' as const,
      commandId: 'override',
      definition,
      mode: 'mock' as const,
      harnessOverrides: { [role.id]: override },
    };
    const bad = { ...request, commandId: 'bad-override', harnessOverrides: { unknown: override } };
    expect(coordinator.startRun(bad).receipt.error?.code).toBe('CAPABILITY_DENIED');
    const result = coordinator.startRun(request);
    expect(result.receipt.error).toBeUndefined();
    expect(resolve).toHaveBeenCalledWith(snapshot.binding, expect.anything(), role.id, {
      runOverride: override,
    });
    expect(definition.roles[0]?.harness).toEqual(snapshot.binding);
    expect(coordinator.startRun(request)).toEqual(result);
    expect(
      coordinator.startRun({
        ...request,
        harnessOverrides: { [role.id]: { ...override, revision: 3 } },
      }).receipt.error?.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('[TC-HAR-010-H] [TC-HAR-008-H] a selected LSP query uses the owned launch approval and cannot run without read permission', async () => {
    const query = {
      serverId: 'typescript',
      path: 'source.ts',
      operation: 'definition' as const,
      position: { line: 0, character: 2 },
    };
    const plan: CheckPlan = {
      purpose: 'lsp',
      query,
      commandId: query.serverId,
      name: 'TypeScript server',
      argv: ['typescript-language-server', '--stdio'],
      timeoutMs: 10000,
      configRevision: 1,
      fingerprint: 'e'.repeat(64),
      tree: 'f'.repeat(40),
      trusted: false,
    };
    const runLsp = vi.fn(
      async () =>
        ({
          serverId: query.serverId,
          operation: query.operation,
          configRevision: 1,
          fingerprint: plan.fingerprint,
          tree: plan.tree,
          source: { path: query.path, sha256: 'b'.repeat(64), version: 1 },
          result: { kind: 'locations', locations: [] },
          durationMs: 1,
          truncated: false,
        }) as LspReport,
    );
    const selected: EffectiveHarnessSnapshot = {
      ...snapshot,
      policy: 'strict',
      resources: [],
      allowedTools: ['lsp_query'],
      projectTools: {
        projectId: 'default',
        revision: 1,
        hash: 'c'.repeat(64),
        checkIds: [],
        lspServerIds: ['typescript'],
      },
    };
    for (const readPermission of [false, true]) {
      const s = setup(true, selected, {
        files: {
          available: () => true,
          execute: async () => ({}),
          planLsp: async () => plan,
          runLsp,
        },
        fileTools: readPermission,
      });
      await s.started.wait();
      await s.host().reportHarness!({
        ok: true,
        snapshotHash: selected.snapshotHash,
        tools: [{ ...descriptor, name: 'lsp_query', source: 'corral', sideEffect: 'external' }],
        diagnostics: [],
      });
      const authorization = await s.host().authorizeTool({ name: 'lsp_query', args: query });
      expect(authorization.ok).toBe(readPermission);
      if (!readPermission) {
        s.done.open();
        continue;
      }
      expect(
        (
          await s
            .host()
            .authorizeTool({ name: 'lsp_query', args: { ...query, serverId: 'unbound' } })
        ).ok,
      ).toBe(false);
      const pending = s.host().executeTool(authorization.toolCallId);
      await vi.waitFor(() =>
        expect(s.events().some((event) => event.type === 'approval.requested')).toBe(true),
      );
      const approval = s.events().find((event) => event.type === 'approval.requested');
      if (!approval) throw new Error('missing approval');
      expect(approval.payload.tool?.purpose).toBe('lsp');
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'approve_lsp',
        runId: s.input().runId,
        type: 'resolve_approval',
        expectedControlRevision: s.coordinator.getSnapshot(s.input().runId).projection
          .controlRevision,
        payload: {
          approvalId: approval.payload.approvalId,
          subjectVersionId: approval.payload.subjectVersionIds[0] ?? '',
          decision: 'approve',
        },
      });
      expect((await pending).ok).toBe(true);
      expect(runLsp).toHaveBeenCalledTimes(1);
      s.done.open();
    }
  });
  it('[TC-HAR-012-N] one approval cannot resume a run with another pending check, and its deadline closes it', async () => {
    const plan: CheckPlan = {
      commandId: 'types',
      name: 'Types',
      argv: ['node', 'check.mjs'],
      timeoutMs: 10000,
      configRevision: 1,
      fingerprint: 'e'.repeat(64),
      tree: 'f'.repeat(40),
      trusted: false,
    };
    const held = new Gate();
    const runCheck = vi.fn(async () => {
      throw new Error('fixture check failure');
    });
    const selected: EffectiveHarnessSnapshot = {
      ...snapshot,
      policy: 'strict',
      resources: [],
      allowedTools: ['run_check'],
      projectTools: {
        projectId: 'default',
        revision: 1,
        hash: 'c'.repeat(64),
        checkIds: ['types'],
        lspServerIds: [],
      },
    };
    const s = setup(true, selected, {
      files: {
        available: () => true,
        execute: async () => ({}),
        planCheck: async () => {
          await held.wait();
          return plan;
        },
        runCheck,
      },
    });
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: [{ ...descriptor, name: 'run_check', source: 'corral', sideEffect: 'external' }],
      diagnostics: [],
    });
    const first = await s.host().authorizeTool({ name: 'run_check', args: { commandId: 'types' } });
    const second = await s
      .host()
      .authorizeTool({ name: 'run_check', args: { commandId: 'types' } });
    const one = s.host().executeTool(first.toolCallId),
      two = s.host().executeTool(second.toolCallId);
    held.open();
    await vi.waitFor(() =>
      expect(s.events().filter((e) => e.type === 'approval.requested')).toHaveLength(2),
    );
    const [approval, other] = s.events().filter((e) => e.type === 'approval.requested');
    if (!approval || !other) throw new Error('missing approvals');
    s.coordinator.submit({
      schemaVersion: '0.1',
      runId: s.input().runId,
      commandId: 'approve_first',
      type: 'resolve_approval',
      expectedControlRevision: s.coordinator.getSnapshot(s.input().runId).projection
        .controlRevision,
      payload: {
        approvalId: approval.payload.approvalId,
        decision: 'approve',
        subjectVersionId: approval.payload.subjectVersionIds[0] ?? '',
      },
    });
    expect(s.coordinator.getSnapshot(s.input().runId).projection.status).toBe('awaiting_user');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(runCheck).not.toHaveBeenCalled();
    s.clock.advance(300001);
    await Promise.all([one, two]);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(
      s
        .events()
        .find(
          (e) =>
            e.type === 'approval.resolved' && e.payload.approvalId === other.payload.approvalId,
        )?.payload,
    ).toMatchObject({ decision: 'reject', reason: 'timeout' });
    s.done.open();
  });
  it('[TC-PLAN-001-H] [TC-PLAN-001-N] [TC-HAR-012-H] a registered check waits for an exact owned approval and executes only once', async () => {
    const plan: CheckPlan = {
      commandId: 'types',
      name: 'Types',
      argv: ['node', 'check.mjs'],
      timeoutMs: 10000,
      configRevision: 1,
      fingerprint: 'e'.repeat(64),
      tree: 'f'.repeat(40),
      trusted: false,
    };
    const runCheck = vi.fn(
      async (input: import('@corral/contracts').CheckExecution) =>
        ({
          verificationId: 'verify_one',
          owner: {
            kind: 'execution',
            runId: input.runId,
            executionId: input.executionId,
            attemptNo: input.attemptNo,
            effectId: input.effectId,
          },
          sessionId: 'session_one',
          commandId: 'types',
          configRevision: 1,
          fingerprint: plan.fingerprint,
          tree: plan.tree,
          state: 'completed',
          verdict: 'pass',
          exitCode: 0,
          signal: null,
          timedOut: false,
          cleanupConfirmed: true,
          targetUnchanged: true,
          durationMs: 1,
          startedAt: '2026-10-18T00:00:00.000Z',
          endedAt: '2026-10-18T00:00:01.000Z',
          retainUntil: '2026-10-25T00:00:00.000Z',
          output: { text: 'ok', bytes: 2, hash: 'b'.repeat(64), truncated: false },
          stale: false,
        }) as VerificationReport & { stale: boolean },
    );
    const selected: EffectiveHarnessSnapshot = {
      ...snapshot,
      policy: 'strict',
      resources: [],
      allowedTools: ['run_check', 'update_plan'],
      projectTools: {
        projectId: 'default',
        revision: 1,
        hash: 'c'.repeat(64),
        checkIds: ['types'],
        lspServerIds: [],
      },
    };
    let currentTree = plan.tree;
    const s = setup(true, selected, {
      plans: true,
      files: {
        available: () => true,
        execute: async () => ({}),
        planCheck: async () => plan,
        runCheck,
        currentTreeForRun: async () => currentTree,
      },
    });
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: [
        { ...descriptor, name: 'run_check', source: 'corral', sideEffect: 'external' },
        { ...descriptor, name: 'update_plan', source: 'corral' },
      ],
      diagnostics: [],
    });
    expect(
      (await s.host().authorizeTool({ name: 'run_check', args: { commandId: 'other' } })).ok,
    ).toBe(false);
    expect(
      (
        await s
          .host()
          .authorizeTool({ name: 'run_check', args: { commandId: 'types', argv: ['other'] } })
      ).ok,
    ).toBe(false);
    const auth = await s.host().authorizeTool({ name: 'run_check', args: { commandId: 'types' } });
    expect(auth.ok).toBe(true);
    const pending = s.host().executeTool(auth.toolCallId);
    await vi.waitFor(() =>
      expect(s.events().some((e) => e.type === 'approval.requested')).toBe(true),
    );
    expect(runCheck).not.toHaveBeenCalled();
    const event = s.events().find((e) => e.type === 'approval.requested');
    if (!event || event.type !== 'approval.requested') throw new Error('approval missing');
    expect(event.payload.tool).toMatchObject({
      executionId: s.input().executionId,
      attemptNo: 1,
      toolCallId: auth.toolCallId,
      fingerprint: plan.fingerprint,
      targetTree: plan.tree,
    });
    expect(
      s.store.getArtifactText(s.input().runId, event.payload.subjectVersionIds[0] ?? ''),
    ).toContain('check.mjs');
    const answer = {
      schemaVersion: '0.1' as const,
      commandId: 'approve_check',
      runId: s.input().runId,
      type: 'resolve_approval' as const,
      expectedControlRevision: s.coordinator.getSnapshot(s.input().runId).projection
        .controlRevision,
      payload: {
        approvalId: event.payload.approvalId,
        decision: 'approve' as const,
        subjectVersionId: event.payload.subjectVersionIds[0] ?? '',
      },
    };
    expect(s.coordinator.submit(answer).status).toBe('applied');
    expect((await pending).ok).toBe(true);
    expect(s.coordinator.submit(answer).status).toBe('applied');
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck.mock.calls[0]?.[0]).toMatchObject({
      runId: s.input().runId,
      executionId: s.input().executionId,
      attemptNo: 1,
    });
    expect(
      s
        .events()
        .filter((e) => e.type === 'tool.finished' && e.payload.toolCallId === auth.toolCallId),
    ).toHaveLength(1);
    expect(() =>
      openRunArchive(exportRunArchive(s.store, s.input().runId, { privateTranscript: true })),
    ).not.toThrow();
    const update = {
      scope: 'execution',
      expectedRevision: 0,
      criteriaVersionId: s.input().criteriaVersionId,
      items: [
        {
          id: 'verify',
          title: 'Verify current files',
          status: 'completed',
          requiresVerification: true,
          evidenceRefs: [`result_${auth.toolCallId}`],
        },
      ],
    };
    expect(await s.host().invokeTool({ name: 'update_plan', args: update })).toMatchObject({
      ok: true,
      result: { revision: 1 },
    });
    currentTree = '0'.repeat(40);
    expect(
      await s.host().invokeTool({ name: 'update_plan', args: { ...update, expectedRevision: 1 } }),
    ).toMatchObject({ ok: false });
    expect(
      s.coordinator.getSnapshot(s.input().runId).projection.tasks[s.input().taskId]?.status,
    ).not.toBe('completed');
    s.done.open();
  });

  it('[TC-HAR-012-N] cancelling a check approval owner closes the request and rejects late approval', async () => {
    const plan: CheckPlan = {
      commandId: 'types',
      name: 'Types',
      argv: ['node', 'check.mjs'],
      timeoutMs: 10000,
      configRevision: 1,
      fingerprint: 'e'.repeat(64),
      tree: 'f'.repeat(40),
      trusted: false,
    };
    const runCheck = vi.fn(async () => {
      throw new Error('must not execute');
    });
    const selected: EffectiveHarnessSnapshot = {
      ...snapshot,
      policy: 'strict',
      resources: [],
      allowedTools: ['run_check'],
      projectTools: {
        projectId: 'default',
        revision: 1,
        hash: 'c'.repeat(64),
        checkIds: ['types'],
        lspServerIds: [],
      },
    };
    const s = setup(true, selected, {
      files: {
        available: () => true,
        execute: async () => ({}),
        planCheck: async () => plan,
        runCheck,
      },
    });
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: [{ ...descriptor, name: 'run_check', source: 'corral', sideEffect: 'external' }],
      diagnostics: [],
    });
    const auth = await s.host().authorizeTool({ name: 'run_check', args: { commandId: 'types' } });
    expect(auth.ok).toBe(true);
    const pending = s.host().executeTool(auth.toolCallId);
    await vi.waitFor(() =>
      expect(s.events().some((e) => e.type === 'approval.requested')).toBe(true),
    );
    const event = s.events().find((e) => e.type === 'approval.requested');
    if (!event || event.type !== 'approval.requested') throw new Error('missing approval');
    s.coordinator.submit({
      schemaVersion: '0.1',
      runId: s.input().runId,
      commandId: 'cancel_owner',
      type: 'cancel',
      payload: { scope: { kind: 'execution', executionId: s.input().executionId }, reason: 'stop' },
    });
    expect((await pending).ok).toBe(false);
    expect(runCheck).not.toHaveBeenCalled();
    expect(
      s.coordinator.getSnapshot(s.input().runId).projection.approvals[event.payload.approvalId]
        ?.status,
    ).not.toBe('pending');
    expect(
      s.coordinator.submit({
        schemaVersion: '0.1',
        runId: s.input().runId,
        commandId: 'late_approve',
        type: 'resolve_approval',
        expectedControlRevision: s.coordinator.getSnapshot(s.input().runId).projection
          .controlRevision,
        payload: {
          approvalId: event.payload.approvalId,
          decision: 'approve',
          subjectVersionId: event.payload.subjectVersionIds[0] ?? '',
        },
      }).status,
    ).toBe('rejected');
    s.done.open();
  });
  it('[TC-HAR-002-N] an admitted native effect can finish during pause without admitting another call', async () => {
    const s = await loaded();
    const args = { text: 'approved' };
    const auth = await s.host().authorizeTool({ name: 'echo', args });
    await s.host().beginNativeTool!(auth.toolCallId, hash(args));
    s.coordinator.submit({
      schemaVersion: '0.1',
      runId: s.input().runId,
      commandId: 'pause_native',
      type: 'pause',
      payload: { scope: 'run' },
    });
    await expect(s.host().finishNativeTool!(auth.toolCallId, 'succeeded')).resolves.toBeUndefined();
    expect(
      s
        .events()
        .filter(
          (event) => event.type === 'tool.finished' && event.payload.toolCallId === auth.toolCallId,
        ),
    ).toHaveLength(1);
    expect(s.coordinator.getSnapshot(s.input().runId).projection.status).not.toBe('running');
    s.coordinator.submit({
      schemaVersion: '0.1',
      runId: s.input().runId,
      commandId: 'stop_native',
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'done' },
    });
    s.done.open();
  });
  it('[TC-HAR-010-H] [TC-HAR-010-N] Pi edit/write aliases retain role file permissions and cannot modify skill resources', async () => {
    const execute = vi.fn(async () => ({ path: 'a.txt', sha256: 'a'.repeat(64) }));
    const selected: EffectiveHarnessSnapshot = {
      ...snapshot,
      policy: 'strict',
      resources: [],
      allowedTools: ['edit', 'write'],
    };
    const s = setup(true, selected, { files: { available: () => true, execute }, fileTools: true });
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: ['edit', 'write'].map((name) => ({
        ...descriptor,
        source: 'corral',
        name,
        sideEffect: 'workspace',
      })),
      diagnostics: [],
    });
    expect(
      await s.host().invokeTool({
        name: 'edit',
        args: { path: 'a.txt', edits: [{ oldText: 'one', newText: 'two' }] },
      }),
    ).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'edit', executionId: s.input().executionId }),
      expect.anything(),
    );
    expect(
      await s.host().authorizeTool({
        name: 'write',
        args: { path: 'skills/writing/SKILL.md', content: 'overwrite' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await s.host().authorizeTool({ name: 'edit', args: { path: 'a.txt', edits: [] } }),
    ).toMatchObject({ ok: false });
    const denied = setup(true, selected, { files: { available: () => true, execute } });
    await denied.started.wait();
    await denied.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: [{ ...descriptor, source: 'corral', name: 'write', sideEffect: 'workspace' }],
      diagnostics: [],
    });
    expect(
      await denied
        .host()
        .authorizeTool({ name: 'write', args: { path: 'a.txt', content: 'overwrite' } }),
    ).toMatchObject({ ok: false });
    s.done.open();
    denied.done.open();
  });
  it('[TC-HAR-007-N] ending an execution closes its outstanding dialog before another attempt can answer', async () => {
    const s = await loaded();
    const answer = s.host().requestExtensionUi!({
      kind: 'input',
      title: 'Name',
      placeholder: '',
      timeoutMs: 1000,
    });
    s.done.open();
    await vi.waitFor(() =>
      expect(s.events().some((e) => e.type === 'execution.settled')).toBe(true),
    );
    expect(s.events().filter((e) => e.type === 'extension.ui_expired')).toMatchObject([
      { payload: { reason: 'execution_ended' } },
    ]);
    expect(await answer).toEqual({ status: 'cancelled' });
  });
  it('[TC-HAR-007-H] UI answers match the execution attempt and command replay is idempotent; bodies stay in private records', async () => {
    const s = await loaded();
    const answer = s.host().requestExtensionUi!({
      kind: 'select',
      title: 'Private question',
      options: ['One', 'Two'],
      timeoutMs: 1000,
    });
    const event = s.events().find((e) => e.type === 'extension.ui_requested');
    if (!event || event.type !== 'extension.ui_requested') throw new Error('request missing');
    expect(JSON.stringify(s.events())).not.toContain('Private question');
    expect(s.store.getArtifactText(s.input().runId, event.payload.bodyRef)).toContain(
      'Private question',
    );
    const command = {
      schemaVersion: '0.1' as const,
      commandId: 'answer',
      runId: s.input().runId,
      expectedControlRevision: 0,
      type: 'answer_extension_ui' as const,
      payload: {
        requestId: event.payload.requestId,
        executionId: s.input().executionId,
        attemptNo: s.input().attemptNo,
        value: 'One',
      },
    };
    expect(
      s.coordinator.submit({
        ...command,
        commandId: 'wrong_attempt',
        payload: { ...command.payload, attemptNo: 999 },
      }).status,
    ).toBe('rejected');
    expect(
      s.coordinator.submit({
        ...command,
        commandId: 'wrong_option',
        payload: { ...command.payload, value: 'Other' },
      }).status,
    ).toBe('rejected');
    expect(
      s.coordinator.submit({ ...command, commandId: 'wrong_revision', expectedControlRevision: 99 })
        .error?.code,
    ).toBe('STALE_CONTROL_REVISION');
    const receipt = s.coordinator.submit(command);
    expect(receipt.status).toBe('applied');
    expect(await answer).toEqual({ status: 'answered', value: 'One' });
    expect(s.coordinator.submit(command)).toEqual(receipt);
    expect(s.coordinator.submit({ ...command, commandId: 'late_answer' }).status).toBe('rejected');
    expect(s.events().filter((e) => e.type === 'extension.ui_answered')).toHaveLength(1);
    expect(() =>
      openRunArchive(exportRunArchive(s.store, s.input().runId, { privateTranscript: true })),
    ).not.toThrow();
    s.done.open();
  });

  it('[TC-HAR-007-N] UI timeouts and cancellation close the exact request and reject a late reply', async () => {
    const s = await loaded();
    const timed = s.host().requestExtensionUi!({
      kind: 'confirm',
      title: 'Continue?',
      message: 'Confirm.',
      timeoutMs: 100,
    });
    s.clock.advance(101);
    expect(await timed).toEqual({ status: 'expired' });
    const waiting = s.host().requestExtensionUi!({
      kind: 'input',
      title: 'Name',
      placeholder: '',
      timeoutMs: 1000,
    });
    const event = s.events().findLast((e) => e.type === 'extension.ui_requested');
    if (!event || event.type !== 'extension.ui_requested') throw new Error('request missing');
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel_ui_run',
      runId: s.input().runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'cancel test' },
    });
    expect(await waiting).toEqual({ status: 'cancelled' });
    expect(
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'late_ui',
        runId: s.input().runId,
        expectedControlRevision: 0,
        type: 'answer_extension_ui',
        payload: {
          requestId: event.payload.requestId,
          executionId: s.input().executionId,
          attemptNo: s.input().attemptNo,
          value: 'Too late',
        },
      }).status,
    ).toBe('rejected');
    expect(s.events().filter((e) => e.type === 'extension.ui_expired')).toHaveLength(2);
  });
  it('[TC-HAR-005-H] [TC-HAR-005-N] read uses the skill broker and cannot read an unbound skill or worktree without role permission', async () => {
    const selected: EffectiveHarnessSnapshot = {
      ...snapshot,
      policy: 'strict',
      allowedTools: ['read'],
      resources: [
        {
          hash: 'c'.repeat(64),
          name: 'fixture',
          version: '1.0.0',
          kind: 'skill',
          required: true,
          entry: 'skills/writing/SKILL.md',
          skillName: 'writing',
          skillMode: 'auto',
        },
      ],
    };
    const s = setup(true, selected);
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: [{ ...descriptor, name: 'read', source: 'corral' }],
      diagnostics: [],
    });
    const result = await s
      .host()
      .invokeTool({ name: 'read', args: { path: 'skills/writing/SKILL.md', offset: 2, limit: 1 } });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.result).toMatchObject({ text: 'first\nsecond\nthird', sha256: 'e'.repeat(64) });
    for (const path of [
      'skills/other/SKILL.md',
      'skills/writing/../other',
      'source.ts',
      '/etc/passwd',
    ])
      expect((await s.host().authorizeTool({ name: 'read', args: { path } })).ok).toBe(false);
    const outOfRange = await s
      .host()
      .invokeTool({ name: 'read', args: { path: 'skills/writing/SKILL.md', offset: 20 } });
    expect(outOfRange.ok).toBe(false);
    s.done.open();
  });
  it('[TC-HAR-009-N] rejects an unresolved profile before creating a Run', () => {
    const s = setup(false);
    expect(s.result.runId).toBeNull();
    expect(s.result.receipt.status).toBe('rejected');
    expect(s.store.listRuns()).toEqual([]);
  });

  it('[TC-HAR-003-H] pins the snapshot, requires load acknowledgement and records each request with its budget reservation', async () => {
    const s = setup();
    await s.started.wait();
    expect(s.input().harness).toEqual(snapshot);
    expect(s.events().find((event) => event.type === 'run.started')?.payload).toMatchObject({
      harnesses: { [s.input().role.id]: snapshot },
    });
    await expect(s.host().prepareModelRequest(record)).rejects.toThrow(/harness/i);
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: snapshot.snapshotHash,
      tools: [descriptor],
      diagnostics: [],
    });
    const permit = await s.host().prepareModelRequest(record);
    expect(s.events().filter((e) => e.type === 'model.request_recorded')).toMatchObject([
      { payload: { modelCallId: permit.modelCallId, ...record } },
    ]);
    expect(s.events().filter((e) => e.type === 'budget.reserved')).toHaveLength(1);
    const archived = openRunArchive(
      exportRunArchive(s.store, s.input().runId, { privateTranscript: true }),
    );
    expect(archived.visibility === 'private' && archived.snapshot.harnesses).toEqual({
      [s.input().role.id]: snapshot,
    });
    await expect(s.host().prepareModelRequest()).rejects.toThrow(/record/i);
    s.done.open();
  });

  it('[TC-HAR-002-H] native calls record unmanaged ownership and settle once', async () => {
    const s = await loaded();
    const args = { text: 'private body', path: '/private/path' };
    const auth = await s.host().authorizeTool({ name: 'echo', args });
    expect(auth.ok).toBe(true);
    await s.host().beginNativeTool!(auth.toolCallId, hash(args));
    await s.host().finishNativeTool!(auth.toolCallId, 'succeeded');
    await expect(s.host().finishNativeTool!(auth.toolCallId, 'succeeded')).rejects.toThrow();
    expect(s.events().filter((e) => e.type === 'tool.allowed')).toMatchObject([
      { payload: { policyVersion: 'role-allowlist@2' } },
    ]);
    expect(s.events().filter((e) => e.type === 'tool.started')).toMatchObject([
      { payload: { management: 'unmanaged_native' } },
    ]);
    expect(s.events().filter((e) => e.type === 'tool.finished')).toHaveLength(1);
    expect(JSON.stringify(s.events())).not.toContain('private body');
    expect(JSON.stringify(s.events())).not.toContain('/private/path');
    s.done.open();
  });

  it('[TC-HAR-008-N] the harness allowlist also restricts Corral tools the role normally allows', async () => {
    const s = setup();
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: snapshot.snapshotHash,
      tools: [descriptor, { ...descriptor, name: 'write_artifact', source: 'corral' }],
      diagnostics: [],
    });
    expect(
      (
        await s
          .host()
          .authorizeTool({ name: 'write_artifact', args: { text: 'not allowed by this profile' } })
      ).ok,
    ).toBe(false);
    s.done.open();
  });

  it('[TC-HAR-002-N] changed arguments, duplicate starts and late reports cannot execute or settle again', async () => {
    const s = await loaded();
    const args = { text: 'approved' };
    const auth = await s.host().authorizeTool({ name: 'echo', args });
    args.text = 'mutated';
    await expect(s.host().beginNativeTool!(auth.toolCallId, hash(args))).rejects.toThrow();
    await s.host().beginNativeTool!(auth.toolCallId, hash({ text: 'approved' }));
    await expect(
      s.host().beginNativeTool!(auth.toolCallId, hash({ text: 'approved' })),
    ).rejects.toThrow();
    s.coordinator.submit({
      schemaVersion: '0.1',
      runId: s.result.runId!,
      commandId: 'cancel',
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    await expect(s.host().finishNativeTool!(auth.toolCallId, 'succeeded')).rejects.toThrow();
    expect(s.events().filter((e) => e.type === 'tool.finished')).toHaveLength(0);
    s.done.open();
  });

  it('[TC-HAR-003-N] rejects mismatched reports and foreign directive IDs; attaches only actual queued directives', async () => {
    const s = setup();
    await s.started.wait();
    await expect(
      s.host().reportHarness!({
        ok: true,
        snapshotHash: 'f'.repeat(64),
        tools: [],
        diagnostics: [],
      }),
    ).rejects.toThrow();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: snapshot.snapshotHash,
      tools: [descriptor],
      diagnostics: [],
    });
    await expect(
      s.host().prepareModelRequest({ ...record, directiveIds: ['foreign'] }),
    ).rejects.toThrow();
    s.coordinator.submit({
      schemaVersion: '0.1',
      runId: s.result.runId!,
      commandId: 'steer',
      type: 'steer',
      payload: {
        targetExecutionId: s.input().executionId,
        text: 'Keep citations.',
        delivery: 'next_request',
      },
    });
    const queued = s.host().pendingDirectives!();
    expect(queued).toHaveLength(1);
    const first = await s.host().prepareModelRequest(record);
    expect(first.directives).toEqual([]);
    await s.host().observe({
      kind: 'model_completed',
      modelCallId: first.modelCallId,
      text: '',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const second = await s
      .host()
      .prepareModelRequest({ ...record, directiveIds: queued.map((d) => d.directiveId) });
    expect(second.directives).toEqual(queued);
    s.done.open();
  });
});

it('[TC-SAFE-002-H] [TC-SAFE-002-N] native permissions bind the final arguments and descriptor, deny wins, and a changed registration cannot use a grant', async () => {
  const selected: EffectiveHarnessSnapshot = {
    ...snapshot,
    permissionPolicies: [
      {
        default: 'ask',
        rules: [
          {
            tool: 'echo',
            action: 'allow',
            descriptorHash: hash(descriptor),
            arguments: { operation: 'read' },
          },
          { tool: 'echo', action: 'deny', arguments: { target: 'private' } },
        ],
      },
    ],
  };
  const s = setup(true, selected);
  expect(s.result.runId).not.toBeNull();
  await s.started.wait();
  await s.host().reportHarness!({
    ok: true,
    snapshotHash: selected.snapshotHash,
    tools: [descriptor],
    diagnostics: [],
  });
  try {
    expect(
      await s
        .host()
        .authorizeTool({ name: 'echo', args: { operation: 'read', target: 'private' } }),
    ).toMatchObject({ ok: false });
    const allowed = await s.host().authorizeTool({ name: 'echo', args: { operation: 'read' } });
    expect(allowed.ok).toBe(true);
    await s.host().beginNativeTool!(allowed.toolCallId, hash({ operation: 'read' }));
    await s.host().finishNativeTool!(allowed.toolCallId, 'succeeded');
    const proposal = {
      name: 'echo',
      args: { operation: 'send', content: 'Private approved content' },
    };
    const call = await s.host().authorizeTool(proposal);
    expect(call.ok).toBe(true);
    const begin = s.host().beginNativeTool!(call.toolCallId, hash(proposal.args)).then(
      () => 'began',
      () => 'refused',
    );
    await vi.waitFor(() =>
      expect(s.events().some((e) => e.type === 'approval.requested')).toBe(true),
    );
    const event = s.events().find((e) => e.type === 'approval.requested');
    if (!event || event.type !== 'approval.requested') throw new Error('missing approval');
    expect(JSON.stringify(s.events())).not.toContain('Private approved content');
    expect(s.events().filter((e) => e.type === 'tool.started')).toHaveLength(1);
    await expect(s.host().beginNativeTool!(call.toolCallId, hash(proposal.args))).rejects.toThrow();
    await s.host().updateHarnessTools!({
      snapshotHash: selected.snapshotHash,
      expectedRevision: 1,
      tools: [{ ...descriptor, schemaHash: 'f'.repeat(64) }],
    });
    expect(
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'grant',
        runId: s.input().runId,
        type: 'resolve_approval',
        expectedControlRevision: 0,
        payload: {
          approvalId: event.payload.approvalId,
          decision: 'approve',
          subjectVersionId: event.payload.subjectVersionIds[0]!,
        },
      }).status,
    ).toBe('applied');
    expect(await begin).toBe('refused');
    expect(s.events().filter((e) => e.type === 'tool.started')).toHaveLength(1);
  } finally {
    s.done.open();
  }
});

it('[TC-SAFE-002-H] [TC-SAFE-002-N] core tools enforce path boundaries and role caps, then execute a granted call only once', async () => {
  const read: ToolDescriptor = { ...descriptor, name: 'read_file', source: 'corral' };
  const remove: ToolDescriptor = { ...read, name: 'delete_file' };
  const paths: unknown[] = [];
  const selected: EffectiveHarnessSnapshot = {
    ...snapshot,
    policy: 'strict',
    resources: [],
    allowedTools: ['read_file', 'delete_file'],
    permissionPolicies: [
      {
        default: 'ask',
        rules: [
          {
            tool: 'read_file',
            action: 'allow',
            descriptorHash: hash(read),
            path: { argument: 'path', prefix: 'src' },
          },
          { tool: 'read_file', action: 'deny', arguments: { path: 'src/private' } },
          { tool: 'delete_file', action: 'allow', descriptorHash: hash(remove) },
        ],
      },
    ],
  };
  const s = setup(true, selected, {
    fileTools: true,
    files: {
      available: () => true,
      execute: async (value) => {
        paths.push(value.args.path);
        return { text: 'fixture' };
      },
    },
  });
  await s.started.wait();
  await s.host().reportHarness!({
    ok: true,
    snapshotHash: selected.snapshotHash,
    tools: [read, remove],
    diagnostics: [],
  });
  try {
    expect(
      await s.host().authorizeTool({ name: 'read_file', args: { path: 'src/private' } }),
    ).toMatchObject({ ok: false });
    expect(
      await s.host().authorizeTool({ name: 'delete_file', args: { path: 'src/file' } }),
    ).toMatchObject({ ok: false });
    expect(
      await s.host().invokeTool({ name: 'read_file', args: { path: 'src/file' } }),
    ).toMatchObject({ ok: true });
    const call = await s
      .host()
      .authorizeTool({ name: 'read_file', args: { path: 'src-other/file' } });
    const running = s.host().executeTool(call.toolCallId);
    await vi.waitFor(() =>
      expect(s.events().some((e) => e.type === 'approval.requested')).toBe(true),
    );
    expect(await s.host().executeTool(call.toolCallId)).toMatchObject({ ok: false });
    const event = s.events().find((e) => e.type === 'approval.requested');
    if (!event || event.type !== 'approval.requested') throw new Error('missing approval');
    expect(paths).toEqual(['src/file']);
    expect(
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'grant_read',
        runId: s.input().runId,
        type: 'resolve_approval',
        expectedControlRevision: 0,
        payload: {
          approvalId: event.payload.approvalId,
          decision: 'approve',
          subjectVersionId: event.payload.subjectVersionIds[0]!,
        },
      }).status,
    ).toBe('applied');
    expect(await running).toMatchObject({ ok: true });
    expect(await s.host().executeTool(call.toolCallId)).toMatchObject({ ok: false });
    expect(paths).toEqual(['src/file', 'src-other/file']);
  } finally {
    s.done.open();
  }
});

it('[TC-PROMPT-002-N] review-only scope refuses native startup before an execution exists', () => {
  const s = setup(true, snapshot, { reviewOnly: true });
  expect(s.result.runId).toBeNull();
  expect(s.result.receipt.error?.code).toBe('CAPABILITY_DENIED');
  expect(s.coordinator.listRuns()).toHaveLength(0);
});
