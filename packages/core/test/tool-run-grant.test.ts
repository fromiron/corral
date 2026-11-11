import {
  type AgentHost,
  type AgentSettlement,
  type AgentStartInput,
  type CheckPlan,
  type CommandExecution,
  type CommandPlan,
  canonicalJson,
  type EffectiveHarnessSnapshot,
  type LspReport,
  type RunEvent,
  type ToolDescriptor,
  type ToolOutcome,
} from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  type FileTools,
  InMemoryRunStore,
  toolRunGrant,
} from '../src/index.ts';

// "Allow for this run" (harness-contract, api-contract `resolve_approval.scope`): a tool approval
// approved with `scope: run` lets later calls of the same Run with exactly its fingerprint pass
// without asking, recorded with the approval they relied on.

const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
const corral = (name: string, sideEffect: ToolDescriptor['sideEffect']): ToolDescriptor => ({
  name,
  source: 'corral',
  schemaHash: hash({ name }),
  exposure: 'direct',
  sideEffect,
});
const writeFile = corral('write_file', 'workspace');
const runCommand = corral('run_command', 'external');
const lspQuery = corral('lsp_query', 'external');
const bookkeeping = [corral('write_artifact', 'workspace'), corral('submit_result', 'workspace')];
const harness = (policyRevision = 1): EffectiveHarnessSnapshot => ({
  binding: { profileId: 'writing', revision: 1 },
  snapshotHash: 'a'.repeat(64),
  piVersion: '1.3.0',
  policyRevision,
  policy: 'trusted-native',
  resources: [],
  allowedTools: [
    'read_file',
    'write_file',
    'run_command',
    'lsp_query',
    'write_artifact',
    'submit_result',
  ],
  tools: [],
  diagnostics: [],
  // Every call asks, except the Corral result bookkeeping and the language server query, whose
  // own launch approval is the one that asks.
  permissionPolicies: [
    {
      default: 'ask',
      rules: [...bookkeeping, lspQuery].map((descriptor) => ({
        tool: descriptor.name,
        action: 'allow' as const,
        descriptorHash: hash(descriptor),
      })),
    },
  ],
  projectTools: {
    projectId: 'default',
    revision: 1,
    hash: 'c'.repeat(64),
    checkIds: [],
    lspServerIds: ['typescript'],
  },
});

interface Started {
  input: AgentStartInput;
  host: AgentHost;
  settle: (settlement: AgentSettlement) => void;
}

function setup(
  options: {
    agents?: string[];
    files?: Partial<FileTools>;
    requireApproval?: boolean;
    /** The harness a role resolves when the Run starts; the Run pins it. */
    resolve?: (roleId: string) => EffectiveHarnessSnapshot;
  } = {},
) {
  const store = new InMemoryRunStore();
  const clock = new FakeClock();
  const started: Started[] = [];
  const written: Record<string, unknown>[] = [];
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    store,
    files: {
      available: () => true,
      execute: async (value) => {
        written.push(value.args);
        return { path: value.args.path, created: true };
      },
      ...options.files,
    } as FileTools,
    harnesses: {
      resolve: (_binding, _definition, roleId) =>
        JSON.parse(
          JSON.stringify(options.resolve ? options.resolve(roleId) : harness()),
        ) as EffectiveHarnessSnapshot,
    },
    agents: {
      start: async (input, host) => {
        let settle!: (settlement: AgentSettlement) => void;
        const settled = new Promise<AgentSettlement>((resolve) => (settle = resolve));
        started.push({ input, host, settle });
        return {
          cancel: async () => settle({ outcome: 'cancelled' }),
          waitForSettlement: () => settled,
        };
      },
    },
  });
  const start = (commandId = 'start') => {
    const definition = linearCorral(options.agents ?? ['writer']);
    for (const role of definition.roles) {
      role.harness = harness().binding;
      // A language server query rides on read_file and the selected project tools.
      role.allowedWorkTools = ['write_artifact', 'read_file', 'write_file', 'run_command'];
    }
    if (options.requireApproval) {
      const output = definition.nodes.find((node) => node.type === 'output');
      if (output?.type === 'output') output.requireApproval = true;
    }
    const result = coordinator.startRun({
      schemaVersion: '0.1',
      commandId,
      definition,
      mode: 'mock',
    });
    if (!result.runId) throw new Error(result.receipt.error?.message ?? 'run did not start');
    return result.runId;
  };
  /** The next execution to start, with its harness loaded. */
  const next = async (index: number): Promise<Started> => {
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(index));
    const execution = started[index]!;
    await execution.host.reportHarness!({
      ok: true,
      snapshotHash: execution.input.harness!.snapshotHash,
      tools: [corral('read_file', 'none'), writeFile, runCommand, lspQuery, ...bookkeeping],
      diagnostics: [],
    });
    return execution;
  };
  const events = (runId: string) => store.readEvents(runId, 0);
  const approvals = (runId: string) =>
    events(runId).filter(
      (event): event is Extract<RunEvent, { type: 'approval.requested' }> =>
        event.type === 'approval.requested',
    );
  const resolve = (
    runId: string,
    approvalId: string,
    decision: 'approve' | 'reject',
    scope?: 'once' | 'run',
  ) => {
    const approval = coordinator.getSnapshot(runId).projection.approvals[approvalId]!;
    return coordinator.submit({
      schemaVersion: '0.1',
      commandId: `resolve_${approvalId}_${decision}_${scope ?? 'none'}`,
      runId,
      type: 'resolve_approval',
      expectedControlRevision: coordinator.getSnapshot(runId).projection.controlRevision,
      payload: {
        approvalId,
        decision,
        subjectVersionId: approval.subjectVersionIds[0]!,
        ...(scope ? { scope } : {}),
      },
    });
  };
  /** Proposes and executes one call; resolves the approval it asks for, if any, as told. */
  const call = async (
    runId: string,
    execution: Started,
    proposal: { name: string; args: Record<string, unknown> },
    answer?: 'once' | 'run' | 'reject',
  ) => {
    const before = approvals(runId).length;
    const auth = await execution.host.authorizeTool(proposal);
    if (!auth.ok) throw new Error(auth.error.message);
    const pending = execution.host.executeTool(auth.toolCallId);
    let asked: string | null = null;
    if (answer) {
      await vi.waitFor(() => expect(approvals(runId).length).toBe(before + 1));
      asked = approvals(runId).at(-1)!.payload.approvalId;
      expect(
        resolve(
          runId,
          asked,
          answer === 'reject' ? 'reject' : 'approve',
          answer === 'reject' ? undefined : answer,
        ).status,
      ).toBe('applied');
    }
    // A call expected to pass on a grant fails fast if it asks instead.
    let outcome: ToolOutcome;
    if (answer) outcome = await pending;
    else {
      let settled: { value: ToolOutcome } | { error: unknown } | null = null;
      pending.then(
        (value) => (settled = { value }),
        (error: unknown) => (settled = { error }),
      );
      await vi.waitFor(() => {
        if (!settled && approvals(runId).length === before) throw new Error('still running');
      });
      if (approvals(runId).length > before) throw new Error('the call asked for approval');
      const result = settled as unknown as { value: ToolOutcome } | { error: unknown };
      if ('error' in result) throw result.error;
      outcome = result.value;
    }
    return {
      outcome,
      asked,
      toolCallId: auth.toolCallId,
      newApprovals: approvals(runId).length - before,
    };
  };
  /** The execution writes and submits a result and ends. */
  const finish = async (execution: Started) => {
    const written = await execution.host.invokeTool({
      name: 'write_artifact',
      args: { text: 'Result' },
    });
    if (!written.ok) throw new Error(written.error.message);
    const submitted = await execution.host.invokeTool({
      name: 'submit_result',
      args: { artifactVersionIds: [written.result.artifactVersionId] },
    });
    if (!submitted.ok) throw new Error(submitted.error.message);
    execution.settle({ outcome: 'succeeded' });
  };
  const authorized = (runId: string) =>
    events(runId).filter(
      (event): event is Extract<RunEvent, { type: 'tool.authorized' }> =>
        event.type === 'tool.authorized',
    );
  return {
    coordinator,
    store,
    clock,
    start,
    next,
    events,
    approvals,
    resolve,
    call,
    finish,
    authorized,
    written,
  };
}

const write = (path: string, text = 'notes') => ({ name: 'write_file', args: { path, text } });

describe('allow for this run', () => {
  it('a second call with the same fingerprint runs without asking and names the approval it relied on', async () => {
    const s = setup();
    const runId = s.start();
    const writer = await s.next(0);
    const first = await s.call(runId, writer, write('notes.md'), 'run');
    expect(first.outcome.ok).toBe(true);
    expect(
      s.events(runId).find((event) => event.type === 'approval.resolved')?.payload,
    ).toMatchObject({ approvalId: first.asked, decision: 'approve', scope: 'run' });

    const second = await s.call(runId, writer, write('notes.md'));
    expect(second.outcome.ok).toBe(true);
    expect(second.newApprovals).toBe(0);
    const fingerprint = s.approvals(runId)[0]!.payload.tool!.fingerprint;
    expect(s.authorized(runId).map((event) => event.payload)).toEqual([
      {
        executionId: writer.input.executionId,
        toolCallId: second.toolCallId,
        approvalId: first.asked,
        fingerprint,
      },
    ]);
    // Both calls ran; the run never waited for the person for the second.
    expect(s.written).toEqual([
      { path: 'notes.md', text: 'notes' },
      { path: 'notes.md', text: 'notes' },
    ]);
    expect(
      s
        .events(runId)
        .filter(
          (event) =>
            event.type === 'execution.state_changed' && event.payload.to === 'waiting_approval',
        ),
    ).toHaveLength(1);
    writer.settle({ outcome: 'cancelled' });
  });

  it('a call whose arguments differ asks again', async () => {
    const s = setup();
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, write('notes.md'), 'run');
    const other = await s.call(runId, writer, write('other.md'), 'once');
    expect(other.newApprovals).toBe(1);
    const changed = await s.call(runId, writer, write('notes.md', 'changed'), 'once');
    expect(changed.newApprovals).toBe(1);
    expect(s.authorized(runId)).toHaveLength(0);
    writer.settle({ outcome: 'cancelled' });
  });

  it('an approval resolved once grants nothing to the next identical call', async () => {
    const s = setup();
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, write('notes.md'), 'once');
    const again = await s.call(runId, writer, write('notes.md'), 'once');
    expect(again.newApprovals).toBe(1);
    expect(s.authorized(runId)).toHaveLength(0);
    expect(
      s
        .events(runId)
        .filter((event) => event.type === 'approval.resolved')
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ decision: 'approve', scope: 'once' }),
      expect.objectContaining({ decision: 'approve', scope: 'once' }),
    ]);
    writer.settle({ outcome: 'cancelled' });
  });

  it('a rejected call grants nothing either', async () => {
    const s = setup();
    const runId = s.start();
    const writer = await s.next(0);
    const denied = await s.call(runId, writer, write('notes.md'), 'reject');
    expect(denied.outcome.ok).toBe(false);
    const again = await s.call(runId, writer, write('notes.md'), 'once');
    expect(again.newApprovals).toBe(1);
    writer.settle({ outcome: 'cancelled' });
  });

  // The Run pins each role's harness, and so its policy revision, when it starts; another
  // role of the same Run may pin another one.
  it.each([
    ['pins the same policy revision passes on the grant', 1, 0],
    ['pins another policy revision asks again', 2, 1],
  ] as const)('a later execution of the Run whose role %s', async (_name, editorRevision, asks) => {
    const s = setup({
      agents: ['writer', 'editor'],
      resolve: (roleId) => harness(roleId === 'editor_role' ? editorRevision : 1),
    });
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, write('notes.md'), 'run');
    await s.finish(writer);
    const editor = await s.next(1);
    expect(editor.input.harness?.policyRevision).toBe(editorRevision);
    const later = await s.call(runId, editor, write('notes.md'), asks ? 'once' : undefined);
    expect(later.outcome.ok).toBe(true);
    expect(later.newApprovals).toBe(asks);
    expect(s.authorized(runId)).toHaveLength(1 - asks);
    editor.settle({ outcome: 'cancelled' });
  });

  it('a tool registration that changed during the Run asks again', async () => {
    const s = setup();
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, write('notes.md'), 'run');
    await writer.host.updateHarnessTools!({
      snapshotHash: writer.input.harness!.snapshotHash,
      expectedRevision: 1,
      tools: [
        corral('read_file', 'none'),
        { ...writeFile, schemaHash: 'e'.repeat(64) },
        runCommand,
        lspQuery,
        ...bookkeeping,
      ],
    });
    const again = await s.call(runId, writer, write('notes.md'), 'once');
    expect(again.newApprovals).toBe(1);
    expect(s.authorized(runId)).toHaveLength(0);
    writer.settle({ outcome: 'cancelled' });
  });

  it('another Run asks again, and the grant ends with its Run', async () => {
    const s = setup();
    const first = s.start('first');
    const writer = await s.next(0);
    await s.call(first, writer, write('notes.md'), 'run');
    await s.finish(writer);
    await vi.waitFor(() =>
      expect(s.coordinator.getSnapshot(first).projection.status).toBe('succeeded'),
    );
    // The ended Run still records the approval; it authorizes nothing outside its Run.
    const fingerprint = s.approvals(first)[0]!.payload.tool!.fingerprint;
    expect(toolRunGrant(s.coordinator.getSnapshot(first).projection, fingerprint)).not.toBeNull();

    const second = s.start('second');
    const next = await s.next(1);
    const again = await s.call(second, next, write('notes.md'), 'once');
    expect(again.newApprovals).toBe(1);
    expect(s.approvals(second)[0]!.payload.tool!.fingerprint).toBe(fingerprint);
    expect(s.authorized(second)).toHaveLength(0);
    next.settle({ outcome: 'cancelled' });
  });

  it('the grants are rebuilt identically from the event log mid-Run', async () => {
    const s = setup();
    const runId = s.start();
    const writer = await s.next(0);
    const granted = await s.call(runId, writer, write('notes.md'), 'run');
    await s.call(runId, writer, write('other.md'), 'once');
    const fingerprint = (path: string) =>
      s
        .approvals(runId)
        .find((event) =>
          s.store.getArtifactText(runId, event.payload.tool!.bodyRef)?.includes(`"path":"${path}"`),
        )!.payload.tool!.fingerprint;
    const live = s.coordinator.getSnapshot(runId).projection;
    const replayed = s.events(runId).reduce(applyEvent, emptyProjection(runId));
    expect(replayed.approvals).toEqual(live.approvals);
    expect(toolRunGrant(replayed, fingerprint('notes.md'))?.approvalId).toBe(granted.asked);
    expect(toolRunGrant(replayed, fingerprint('other.md'))).toBeNull();
    // The stored projection, as a reader reloads it, holds the same grant.
    expect(
      toolRunGrant(s.store.getRun(runId)!.projection, fingerprint('notes.md'))?.approvalId,
    ).toBe(granted.asked);
    // The live Run keeps using it.
    expect((await s.call(runId, writer, write('notes.md'))).newApprovals).toBe(0);
    writer.settle({ outcome: 'cancelled' });
  });

  it.each(['run', 'once'] as const)(
    'a rejection with scope %s: run is SCHEMA_INVALID and leaves the approval open; once is a plain rejection',
    async (scope) => {
      const s = setup();
      const runId = s.start();
      const writer = await s.next(0);
      const auth = await writer.host.authorizeTool(write('notes.md'));
      if (!auth.ok) throw new Error(auth.error.message);
      const pending = writer.host.executeTool(auth.toolCallId);
      await vi.waitFor(() => expect(s.approvals(runId)).toHaveLength(1));
      const approvalId = s.approvals(runId)[0]!.payload.approvalId;
      const receipt = s.resolve(runId, approvalId, 'reject', scope);
      if (scope === 'run') {
        expect(receipt.status).toBe('rejected');
        expect(receipt.error?.code).toBe('SCHEMA_INVALID');
        expect(s.coordinator.getSnapshot(runId).projection.approvals[approvalId]?.status).toBe(
          'pending',
        );
        expect(s.resolve(runId, approvalId, 'reject').status).toBe('applied');
      } else expect(receipt.status).toBe('applied');
      expect((await pending).ok).toBe(false);
      expect(
        s.events(runId).find((event) => event.type === 'approval.resolved')?.payload,
      ).not.toHaveProperty('scope');
      writer.settle({ outcome: 'cancelled' });
    },
  );

  it('scope run on an approval that is not a tool call is SCHEMA_INVALID', async () => {
    const s = setup({ requireApproval: true });
    const runId = s.start();
    const writer = await s.next(0);
    await s.finish(writer);
    await vi.waitFor(() => expect(s.approvals(runId)).toHaveLength(1));
    const finalOutput = s.approvals(runId)[0]!.payload;
    expect(finalOutput.kind).toBe('final_output');
    const refused = s.resolve(runId, finalOutput.approvalId, 'approve', 'run');
    expect(refused.error?.code).toBe('SCHEMA_INVALID');
    expect(s.resolve(runId, finalOutput.approvalId, 'approve').status).toBe('applied');
    expect(
      s.events(runId).find((event) => event.type === 'approval.resolved')?.payload,
    ).not.toHaveProperty('scope');
    await vi.waitFor(() =>
      expect(s.coordinator.getSnapshot(runId).projection.status).toBe('succeeded'),
    );
  });

  it('a language server launch approval cannot be allowed for the run and still asks each time', async () => {
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
      async (): Promise<LspReport> => ({
        serverId: query.serverId,
        operation: query.operation,
        configRevision: 1,
        fingerprint: plan.fingerprint,
        tree: plan.tree,
        source: { path: query.path, sha256: 'b'.repeat(64), version: 1 },
        result: { kind: 'locations' as const, locations: [] },
        durationMs: 1,
        truncated: false,
      }),
    );
    const s = setup({ files: { planLsp: async () => plan, runLsp } });
    const runId = s.start();
    const writer = await s.next(0);
    for (const round of [1, 2]) {
      const auth = await writer.host.authorizeTool({ name: 'lsp_query', args: query });
      if (!auth.ok) throw new Error(auth.error.message);
      const pending = writer.host.executeTool(auth.toolCallId);
      await vi.waitFor(() => expect(s.approvals(runId)).toHaveLength(round));
      const approval = s.approvals(runId).at(-1)!.payload;
      expect(approval.tool?.purpose).toBe('lsp');
      if (round === 1)
        expect(s.resolve(runId, approval.approvalId, 'approve', 'run').error?.code).toBe(
          'SCHEMA_INVALID',
        );
      expect(s.resolve(runId, approval.approvalId, 'approve').status).toBe('applied');
      expect((await pending).ok).toBe(true);
    }
    expect(runLsp).toHaveBeenCalledTimes(2);
    expect(s.authorized(runId)).toHaveLength(0);
    writer.settle({ outcome: 'cancelled' });
  });
});

describe('allow for this run on a command', () => {
  const plan: CommandPlan = {
    operationId: 'command_one',
    hostId: 'local',
    sessionId: 'session_one',
    workspaceBindingId: 'workspace_one',
    worktreeId: 'worktree_one',
    rootIdentity: 'c'.repeat(64),
    tree: 'd'.repeat(40),
    shellId: 'bash',
    command: 'npm test',
    executable: 'bash',
    argv: ['-lc', 'npm test'],
    cwd: '.',
    environmentHash: 'e'.repeat(64),
    timeoutMs: 10000,
    mode: 'foreground',
    fingerprint: 'f'.repeat(64),
  };
  const report = {
    operationId: plan.operationId,
    state: 'completed' as const,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cleanupConfirmed: true,
    output: { text: 'ok', bytes: 2, hash: 'a'.repeat(64), truncated: false },
  };
  /**
   * `perCall` plans the way the local server does: the operation is named after the call's run,
   * execution, attempt and effect, and its launch fingerprint covers that name.
   */
  function commandSetup(perCall = false) {
    const runCommand = vi.fn<NonNullable<FileTools['runCommand']>>(async () => report);
    const copy = { rootIdentity: plan.rootIdentity };
    const planCommand = async (input: CommandExecution): Promise<CommandPlan> => {
      const operationId = perCall ? `command_${input.effectId}` : plan.operationId;
      const cwd = input.request.cwd ?? '.';
      const { rootIdentity } = copy;
      return {
        ...plan,
        operationId,
        cwd,
        rootIdentity,
        fingerprint: hash({ operationId, cwd, rootIdentity }),
      };
    };
    return { ...setup({ files: { planCommand, runCommand } }), runCommand, copy };
  }
  const command = (cwd?: string) => ({
    name: 'run_command',
    args: { command: 'npm test', ...(cwd ? { cwd } : {}) },
  });

  it('the same launch passes on the grant and runs with its own launch fingerprint', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    const first = await s.call(runId, writer, command(), 'run');
    expect(first.outcome.ok).toBe(true);
    const second = await s.call(runId, writer, command());
    expect(second.outcome.ok).toBe(true);
    expect(second.newApprovals).toBe(0);
    expect(s.authorized(runId).map((event) => event.payload)).toEqual([
      expect.objectContaining({ toolCallId: second.toolCallId, approvalId: first.asked }),
    ]);
    expect(s.runCommand).toHaveBeenCalledTimes(2);
    expect(s.runCommand.mock.calls[1]?.[2]).toBe(
      hash({ operationId: plan.operationId, cwd: '.', rootIdentity: plan.rootIdentity }),
    );
    writer.settle({ outcome: 'cancelled' });
  });

  it('a different working directory asks again', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, command(), 'run');
    const elsewhere = await s.call(runId, writer, command('src'), 'once');
    expect(elsewhere.newApprovals).toBe(1);
    expect(s.authorized(runId)).toHaveLength(0);
    writer.settle({ outcome: 'cancelled' });
  });

  it('a working copy whose identity changed during the Run asks again', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, command(), 'run');
    s.copy.rootIdentity = '9'.repeat(64);
    const recreated = await s.call(runId, writer, command(), 'once');
    expect(recreated.newApprovals).toBe(1);
    expect(s.authorized(runId)).toHaveLength(0);
    writer.settle({ outcome: 'cancelled' });
  });

  it('a launch planned per call, as the local server plans it, never shares a fingerprint and asks again', async () => {
    const s = commandSetup(true);
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, command(), 'run');
    const again = await s.call(runId, writer, command(), 'once');
    expect(again.newApprovals).toBe(1);
    const [one, two] = s.approvals(runId);
    expect(one!.payload.tool!.fingerprint).not.toBe(two!.payload.tool!.fingerprint);
    expect(s.authorized(runId)).toHaveLength(0);
    writer.settle({ outcome: 'cancelled' });
  });

  it('cancelling the Run while a granted call runs ends it as cancelling an approved call does', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, command(), 'run');
    const entered = new Gate();
    s.runCommand.mockImplementation(async (_input, _plan, _approved, cancellation) => {
      entered.open();
      await new Promise<void>((resolve) => cancellation.onCancel(resolve));
      return { ...report, state: 'cancelled', exitCode: null };
    });
    const auth = await writer.host.authorizeTool(command());
    if (!auth.ok) throw new Error(auth.error.message);
    const pending = writer.host.executeTool(auth.toolCallId);
    await entered.wait();
    expect(s.authorized(runId)).toHaveLength(1);
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel_granted',
      runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'user stopped work' },
    });
    expect((await pending).ok).toBe(false);
    const started = s
      .events(runId)
      .find(
        (event) => event.type === 'tool.started' && event.payload.toolCallId === auth.toolCallId,
      );
    if (started?.type !== 'tool.started') throw new Error('missing command effect');
    expect(
      s
        .events(runId)
        .find(
          (event) =>
            event.type === 'effect.settled' && event.payload.effectId === started.payload.effectId,
        )?.payload,
    ).toMatchObject({ outcome: 'cancelled' });
    expect(
      s
        .events(runId)
        .find(
          (event) => event.type === 'tool.finished' && event.payload.toolCallId === auth.toolCallId,
        )?.payload,
    ).toMatchObject({ error: null });
    expect(s.approvals(runId)).toHaveLength(1);
    writer.settle({ outcome: 'cancelled' });
  });
});
