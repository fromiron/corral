import {
  type AgentHost,
  type AgentSettlement,
  type AgentStartInput,
  type CheckPlan,
  type CommandExecution,
  type CommandPlan,
  type CorralDefinition,
  canonicalJson,
  type EffectiveHarnessSnapshot,
  type LspReport,
  type RunEvent,
  type Scheduler,
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
  commandGrantFingerprint,
  emptyProjection,
  type FileTools,
  InMemoryRunStore,
  toolRunGrant,
  validToolPermissionPlan,
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
const harness = (policyRevision = 1, snapshotHash = 'a'.repeat(64)): EffectiveHarnessSnapshot => ({
  binding: { profileId: 'writing', revision: 1 },
  snapshotHash,
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
    /** The team, when not a line of `agents`. */
    definition?: () => CorralDefinition;
    /** Deadlines, when they should not fire as the clock moves. */
    timers?: Scheduler;
  } = {},
) {
  const store = new InMemoryRunStore();
  const clock = new FakeClock();
  const started: Started[] = [];
  const written: Record<string, unknown>[] = [];
  const coordinator = new Coordinator({
    clock,
    timers: options.timers ?? clock,
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
    const definition = options.definition?.() ?? linearCorral(options.agents ?? ['writer']);
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
  const cancel = (runId: string, executionId: string) =>
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: `cancel_${executionId}`,
      runId,
      type: 'cancel',
      payload: { scope: { kind: 'execution', executionId }, reason: 'user stopped it' },
    });
  /** Starts one call and waits until it asks; returns its approval and the call's outcome. */
  const ask = async (
    runId: string,
    execution: Started,
    proposal: { name: string; args: Record<string, unknown> },
  ) => {
    const before = approvals(runId).length;
    const auth = await execution.host.authorizeTool(proposal);
    if (!auth.ok) throw new Error(auth.error.message);
    const outcome = execution.host.executeTool(auth.toolCallId);
    await vi.waitFor(() => expect(approvals(runId).length).toBe(before + 1));
    return { approval: approvals(runId).at(-1)!.payload, outcome, toolCallId: auth.toolCallId };
  };
  /** Starts these calls of one execution together: once one waits for approval, none can start. */
  const startAll = async (
    execution: Started,
    proposals: { name: string; args: Record<string, unknown> }[],
  ) =>
    (await Promise.all(proposals.map((proposal) => execution.host.authorizeTool(proposal)))).map(
      (auth) => {
        if (!auth.ok) throw new Error(auth.error.message);
        return {
          toolCallId: auth.toolCallId,
          outcome: execution.host.executeTool(auth.toolCallId),
        };
      },
    );
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
    cancel,
    ask,
    startAll,
    authorized,
    written,
  };
}

/** p, then a and b at once, meeting at a Join before m and the Output. */
function forkedCorral(): CorralDefinition {
  const definition = linearCorral(['p', 'a', 'b', 'm']);
  for (const node of definition.nodes)
    if (node.type === 'agent' && node.id !== 'p')
      node.inputBindings = [{ kind: 'task_output', name: 'previous', sourceNodeId: 'p' }];
  definition.nodes.push({ id: 'j', type: 'join', label: 'j', policy: 'all' });
  const edge = (id: string, source: string, target: string) => ({
    id,
    source,
    sourcePort: 'out' as const,
    target,
    targetPort: 'in' as const,
  });
  definition.controlEdges = [
    edge('e1', 'p', 'a'),
    edge('e2', 'p', 'b'),
    edge('e3', 'a', 'j'),
    edge('e4', 'b', 'j'),
    edge('e5', 'j', 'm'),
    edge('e6', 'm', 'output'),
  ];
  return definition;
}

/** Deadlines that fire only when the test says so, as a timer running late would. */
function lateTimers() {
  const pending: { ms: number; fn: () => void }[] = [];
  const timers: Scheduler = {
    after: (ms, fn) => {
      const timer = { ms, fn };
      pending.push(timer);
      return () => {
        const index = pending.indexOf(timer);
        if (index >= 0) pending.splice(index, 1);
      };
    },
  };
  /** Fires the oldest deadline still set for this many milliseconds. */
  const fire = (ms: number) => {
    const index = pending.findIndex((timer) => timer.ms === ms);
    if (index < 0) throw new Error(`no ${ms} ms deadline is set`);
    const [timer] = pending.splice(index, 1);
    timer!.fn();
  };
  return { timers, fire };
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

  // The Run pins each role's harness, its snapshot and policy revision, when it starts; another
  // role of the same Run may pin another one.
  it.each([
    ['pins the same policy revision passes on the grant', 1, 'a'.repeat(64), 0],
    ['pins another policy revision asks again', 2, 'a'.repeat(64), 1],
    ['pins another harness snapshot asks again', 1, 'b'.repeat(64), 1],
  ] as const)(
    'a later execution of the Run whose role %s',
    async (_name, editorRevision, editorSnapshot, asks) => {
      const s = setup({
        agents: ['writer', 'editor'],
        resolve: (roleId) =>
          roleId === 'editor_role' ? harness(editorRevision, editorSnapshot) : harness(),
      });
      const runId = s.start();
      const writer = await s.next(0);
      await s.call(runId, writer, write('notes.md'), 'run');
      await s.finish(writer);
      const editor = await s.next(1);
      expect(editor.input.harness?.policyRevision).toBe(editorRevision);
      expect(editor.input.harness?.snapshotHash).toBe(editorSnapshot);
      const later = await s.call(runId, editor, write('notes.md'), asks ? 'once' : undefined);
      expect(later.outcome.ok).toBe(true);
      expect(later.newApprovals).toBe(asks);
      expect(s.authorized(runId)).toHaveLength(1 - asks);
      editor.settle({ outcome: 'cancelled' });
    },
  );

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

  it('a waiting identical call in another execution of the Run is allowed with the run-wide approval', async () => {
    const s = setup({ definition: forkedCorral });
    const runId = s.start();
    await s.finish(await s.next(0));
    const a = await s.next(1);
    const b = await s.next(2);
    const first = await s.ask(runId, a, write('notes.md'));
    const other = await s.ask(runId, b, write('notes.md'));
    expect(other.approval.tool!.executionId).toBe(b.input.executionId);
    expect(other.approval.tool!.executionId).not.toBe(first.approval.tool!.executionId);
    expect(other.approval.tool!.fingerprint).toBe(first.approval.tool!.fingerprint);
    expect(s.resolve(runId, first.approval.approvalId, 'approve', 'run').status).toBe('applied');
    expect((await first.outcome).ok).toBe(true);
    expect((await other.outcome).ok).toBe(true);
    expect(
      s
        .events(runId)
        .filter((event) => event.type === 'approval.resolved')
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ approvalId: first.approval.approvalId, scope: 'run' }),
      expect.objectContaining({
        approvalId: other.approval.approvalId,
        decision: 'approve',
        actor: 'coordinator',
        reason: 'allowed_for_run',
      }),
    ]);
    expect(s.authorized(runId).map((event) => event.payload)).toEqual([
      {
        executionId: b.input.executionId,
        toolCallId: other.toolCallId,
        approvalId: first.approval.approvalId,
        fingerprint: first.approval.tool!.fingerprint,
      },
    ]);
    expect(s.written).toEqual([
      { path: 'notes.md', text: 'notes' },
      { path: 'notes.md', text: 'notes' },
    ]);
    a.settle({ outcome: 'cancelled' });
    b.settle({ outcome: 'cancelled' });
  });

  it('a waiting identical call whose execution was cancelled ends on its own path, untouched by the run-wide approval', async () => {
    const s = setup({ definition: forkedCorral });
    const runId = s.start();
    await s.finish(await s.next(0));
    const a = await s.next(1);
    const b = await s.next(2);
    const first = await s.ask(runId, a, write('notes.md'));
    const other = await s.ask(runId, b, write('notes.md'));
    expect(s.cancel(runId, b.input.executionId).status).not.toBe('rejected');
    expect((await other.outcome).ok).toBe(false);
    const closed = { status: 'rejected', reason: 'cancelled' };
    expect(
      s.coordinator.getSnapshot(runId).projection.approvals[other.approval.approvalId],
    ).toMatchObject(closed);
    expect(s.resolve(runId, first.approval.approvalId, 'approve', 'run').status).toBe('applied');
    expect((await first.outcome).ok).toBe(true);
    expect(
      s.coordinator.getSnapshot(runId).projection.approvals[other.approval.approvalId],
    ).toMatchObject(closed);
    expect(s.authorized(runId)).toHaveLength(0);
    expect(s.written).toEqual([{ path: 'notes.md', text: 'notes' }]);
    a.settle({ outcome: 'cancelled' });
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
  const report = {
    operationId: 'command_any',
    state: 'completed' as const,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cleanupConfirmed: true,
    output: { text: 'ok', bytes: 2, hash: 'a'.repeat(64), truncated: false },
  };
  /**
   * Plans the way the local server does: each call is its own operation, named after its effect,
   * on the working tree as it is now; its exact fingerprint covers both, while its launch
   * fingerprint covers only the launch (executable and content, argv, shell, cwd, environment,
   * timeout, mode, working-copy identity, source command and final arguments).
   */
  function commandSetup(options: Parameters<typeof setup>[0] = {}) {
    const runCommand = vi.fn<NonNullable<FileTools['runCommand']>>(async () => report);
    const world = {
      tree: 'd'.repeat(40),
      rootIdentity: 'c'.repeat(64),
      executableHash: '1'.repeat(64),
      /** Holds the call planned in this order (from 1) until the test opens its gate. */
      hold: {} as Record<number, Gate>,
      planning: 0,
    };
    const plans: CommandPlan[] = [];
    const planCommand = async (input: CommandExecution): Promise<CommandPlan> => {
      world.planning += 1;
      await world.hold[world.planning]?.wait();
      const { request } = input;
      const shellId = request.shellId ?? 'bash';
      const launch = {
        hostId: 'local',
        sessionId: 'session_one',
        workspaceBindingId: 'workspace_one',
        worktreeId: 'worktree_one',
        rootIdentity: world.rootIdentity,
        shellId,
        command: request.command,
        executable: shellId,
        argv: ['-lc', request.command],
        cwd: request.cwd ?? '.',
        environmentHash: 'e'.repeat(64),
        timeoutMs: request.timeoutMs ?? 120000,
        mode: request.mode ?? 'foreground',
      };
      const call = { ...launch, operationId: `command_${input.effectId}`, tree: world.tree };
      const plan: CommandPlan = {
        ...call,
        launchFingerprint: hash({ ...launch, executableHash: world.executableHash, request }),
        fingerprint: hash({ ...call, executableHash: world.executableHash }),
      };
      plans.push(plan);
      return plan;
    };
    return {
      ...setup({ ...options, files: { planCommand, runCommand, stopRunServices: async () => {} } }),
      runCommand,
      world,
      plans,
    };
  }
  const command = (args: Record<string, unknown> = {}) => ({
    name: 'run_command',
    args: { command: 'npm test', ...args },
  });

  it('the same command after the Run edited files passes on the grant, launched on its own exact plan', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    const first = await s.call(runId, writer, command(), 'run');
    expect(first.outcome.ok).toBe(true);
    // The request carries the call's exact fingerprint, which the body proves, and the launch
    // key a grant for the run is matched by.
    const asked = s.approvals(runId)[0]!.payload.tool!;
    const body = JSON.parse(s.store.getArtifactText(runId, asked.bodyRef)!);
    expect(validToolPermissionPlan(body)).toBe(true);
    expect(asked.fingerprint).toBe(body.fingerprint);
    expect(asked.grantFingerprint).toBe(
      commandGrantFingerprint(body, s.plans[0]!.launchFingerprint),
    );
    expect(asked.grantFingerprint).not.toBe(asked.fingerprint);

    s.world.tree = '7'.repeat(40);
    const second = await s.call(runId, writer, command());
    expect(second.outcome.ok).toBe(true);
    expect(second.newApprovals).toBe(0);
    expect(s.plans[1]!.fingerprint).not.toBe(s.plans[0]!.fingerprint);
    expect(s.authorized(runId).map((event) => event.payload)).toEqual([
      {
        executionId: writer.input.executionId,
        toolCallId: second.toolCallId,
        approvalId: first.asked,
        fingerprint: asked.grantFingerprint,
      },
    ]);
    // The server gets this call's own exact fingerprint, as after Allow once on it.
    expect(s.runCommand).toHaveBeenCalledTimes(2);
    expect(s.runCommand.mock.calls[1]?.[1]).toEqual(s.plans[1]);
    expect(s.runCommand.mock.calls[1]?.[2]).toBe(s.plans[1]!.fingerprint);
    writer.settle({ outcome: 'cancelled' });
  });

  it.each([
    ['other command text', command({ command: 'npm run lint' }), () => {}],
    ['another working directory', command({ cwd: 'src' }), () => {}],
    ['another timeout', command({ timeoutMs: 30000 }), () => {}],
    ['another shell', command({ shellId: 'sh' }), () => {}],
    ['a service instead of a foreground run', command({ mode: 'service' }), () => {}],
    [
      'a changed executable',
      command(),
      (world: { executableHash: string }) => {
        world.executableHash = '2'.repeat(64);
      },
    ],
    [
      'another working copy',
      command(),
      (world: { rootIdentity: string }) => {
        world.rootIdentity = '9'.repeat(64);
      },
    ],
  ] as const)('%s asks again', async (_name, next, change) => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, command(), 'run');
    change(s.world);
    const again = await s.call(runId, writer, next, 'reject');
    expect(again.newApprovals).toBe(1);
    expect(s.authorized(runId)).toHaveLength(0);
    expect(s.runCommand).toHaveBeenCalledTimes(1);
    writer.settle({ outcome: 'cancelled' });
  });

  it('a command allowed once asks again', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, command(), 'once');
    const again = await s.call(runId, writer, command(), 'once');
    expect(again.newApprovals).toBe(1);
    expect(s.authorized(runId)).toHaveLength(0);
    writer.settle({ outcome: 'cancelled' });
  });

  it('another Run asks again for the same command', async () => {
    const s = commandSetup();
    const first = s.start('first');
    const writer = await s.next(0);
    await s.call(first, writer, command(), 'run');
    await s.finish(writer);
    await vi.waitFor(() =>
      expect(s.coordinator.getSnapshot(first).projection.status).toBe('succeeded'),
    );
    const second = s.start('second');
    const next = await s.next(1);
    const again = await s.call(second, next, command(), 'once');
    expect(again.newApprovals).toBe(1);
    expect(s.approvals(second)[0]!.payload.tool!.grantFingerprint).toBe(
      s.approvals(first)[0]!.payload.tool!.grantFingerprint,
    );
    expect(s.authorized(second)).toHaveLength(0);
    next.settle({ outcome: 'cancelled' });
  });

  it('a grant on another tool never covers a command, nor a command grant another tool', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    // A command allowed for the run: a file write still asks, and the other way round.
    expect((await s.call(runId, writer, command(), 'run')).newApprovals).toBe(1);
    expect((await s.call(runId, writer, write('notes.md'), 'run')).newApprovals).toBe(1);
    // Each grant covers its own call only.
    expect((await s.call(runId, writer, command())).newApprovals).toBe(0);
    expect((await s.call(runId, writer, write('notes.md'))).newApprovals).toBe(0);
    const [commandGrant, writeGrant] = s.approvals(runId).map((event) => event.payload);
    expect(commandGrant!.tool!.grantFingerprint).toBeDefined();
    expect(writeGrant!.tool!.grantFingerprint).toBeUndefined();
    expect(s.authorized(runId).map((event) => event.payload)).toEqual([
      expect.objectContaining({
        approvalId: commandGrant!.approvalId,
        fingerprint: commandGrant!.tool!.grantFingerprint,
      }),
      expect.objectContaining({
        approvalId: writeGrant!.approvalId,
        fingerprint: writeGrant!.tool!.fingerprint,
      }),
    ]);
    writer.settle({ outcome: 'cancelled' });
  });

  it('a command grant is rebuilt identically from the event log', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    const granted = await s.call(runId, writer, command(), 'run');
    const key = s.approvals(runId)[0]!.payload.tool!.grantFingerprint!;
    const replayed = s.events(runId).reduce(applyEvent, emptyProjection(runId));
    expect(replayed.approvals).toEqual(s.coordinator.getSnapshot(runId).projection.approvals);
    expect(toolRunGrant(replayed, key)?.approvalId).toBe(granted.asked);
    // The exact fingerprint the approval carries is not a key a later call can match.
    const exact = s.approvals(runId)[0]!.payload.tool!.fingerprint;
    expect(exact).not.toBe(key);
    expect(toolRunGrant(replayed, exact)).toBeNull();
    writer.settle({ outcome: 'cancelled' });
  });

  it('a waiting identical command is allowed with the card the person allowed for the run', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    const calls = await Promise.all(
      [command(), command(), command({ cwd: 'src' })].map((proposal) =>
        writer.host.authorizeTool(proposal),
      ),
    );
    const pending = calls.map((auth) => {
      if (!auth.ok) throw new Error(auth.error.message);
      return writer.host.executeTool(auth.toolCallId);
    });
    await vi.waitFor(() => expect(s.approvals(runId)).toHaveLength(3));
    const [one, two, other] = s.approvals(runId).map((event) => event.payload);
    expect(one!.tool!.grantFingerprint).toBe(two!.tool!.grantFingerprint);
    expect(s.resolve(runId, two!.approvalId, 'approve', 'run').status).toBe('applied');
    expect((await pending[0])!.ok).toBe(true);
    expect((await pending[1])!.ok).toBe(true);
    expect(
      s
        .events(runId)
        .filter((event) => event.type === 'approval.resolved')
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ approvalId: two!.approvalId, scope: 'run', actor: 'local_user' }),
      expect.objectContaining({
        approvalId: one!.approvalId,
        decision: 'approve',
        reason: 'allowed_for_run',
      }),
    ]);
    expect(s.authorized(runId).map((event) => event.payload)).toEqual([
      expect.objectContaining({
        toolCallId: calls[0]!.toolCallId,
        approvalId: two!.approvalId,
        fingerprint: two!.tool!.grantFingerprint,
      }),
    ]);
    // Each ran on its own exact plan; the different call still waits for the person.
    expect(s.runCommand.mock.calls.map((call) => call[2]).sort()).toEqual(
      s.plans
        .filter((plan) => plan.cwd === '.')
        .map((plan) => plan.fingerprint)
        .sort(),
    );
    expect(s.coordinator.getSnapshot(runId).projection.approvals[other!.approvalId]?.status).toBe(
      'pending',
    );
    expect(s.resolve(runId, other!.approvalId, 'reject').status).toBe('applied');
    expect((await pending[2])!.ok).toBe(false);
    writer.settle({ outcome: 'cancelled' });
  });

  it('a waiting identical command past its deadline is left to its own deadline by the run-wide approval', async () => {
    const late = lateTimers();
    const s = commandSetup({ timers: late.timers });
    const runId = s.start();
    const writer = await s.next(0);
    // The second call asks later: its planning waits until the first has waited a while.
    const later = new Gate();
    s.world.hold[2] = later;
    const calls = await s.startAll(writer, [command(), command()]);
    await vi.waitFor(() => expect(s.approvals(runId)).toHaveLength(1));
    s.clock.advance(200_000);
    later.open();
    await vi.waitFor(() => expect(s.approvals(runId)).toHaveLength(2));
    const [first, second] = s.approvals(runId).map((event) => event.payload);
    expect(second!.tool!.grantFingerprint).toBe(first!.tool!.grantFingerprint);
    // The first is past its deadline, while its timer has not fired yet.
    s.clock.advance(150_000);
    expect(s.resolve(runId, second!.approvalId, 'approve', 'run').status).toBe('applied');
    expect((await calls[1]!.outcome).ok).toBe(true);
    expect(s.coordinator.getSnapshot(runId).projection.approvals[first!.approvalId]?.status).toBe(
      'pending',
    );
    expect(s.authorized(runId)).toHaveLength(0);
    // Its own deadline ends it as a refusal; only the allowed call launched.
    late.fire(300_000);
    expect((await calls[0]!.outcome).ok).toBe(false);
    expect(s.coordinator.getSnapshot(runId).projection.approvals[first!.approvalId]).toMatchObject({
      status: 'rejected',
      reason: 'timeout',
    });
    expect(s.runCommand).toHaveBeenCalledTimes(1);
    expect(s.runCommand.mock.calls[0]?.[2]).toBe(s.plans[1]!.fingerprint);
    writer.settle({ outcome: 'cancelled' });
  });

  it('a decision on a waiting card the run-wide approval already closed is APPROVAL_STALE and changes nothing', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    const calls = await s.startAll(writer, [command(), command()]);
    await vi.waitFor(() => expect(s.approvals(runId)).toHaveLength(2));
    const [first, second] = s.approvals(runId).map((event) => event.payload);
    expect(s.resolve(runId, second!.approvalId, 'approve', 'run').status).toBe('applied');
    expect((await calls[0]!.outcome).ok).toBe(true);
    expect((await calls[1]!.outcome).ok).toBe(true);
    const events = s.events(runId).length;
    const projection = s.coordinator.getSnapshot(runId).projection;
    const late = s.resolve(runId, first!.approvalId, 'reject');
    expect(late.status).toBe('rejected');
    expect(late.error?.code).toBe('APPROVAL_STALE');
    expect(s.events(runId)).toHaveLength(events);
    expect(s.coordinator.getSnapshot(runId).projection).toEqual(projection);
    expect(projection.approvals[first!.approvalId]).toMatchObject({
      status: 'approved',
      reason: 'allowed_for_run',
    });
    expect(s.runCommand).toHaveBeenCalledTimes(2);
    writer.settle({ outcome: 'cancelled' });
  });

  it('a granted command whose execution is cancelled before its launch does not launch', async () => {
    const s = commandSetup();
    const runId = s.start();
    const writer = await s.next(0);
    await s.call(runId, writer, command(), 'run');
    // The next call is planning when the Run is told to pause, so once it passes on the grant it
    // waits at the boundary before its launch; there its execution is cancelled.
    const hold = new Gate();
    s.world.hold[2] = hold;
    const auth = await writer.host.authorizeTool(command());
    if (!auth.ok) throw new Error(auth.error.message);
    const pending = writer.host.executeTool(auth.toolCallId);
    await vi.waitFor(() => expect(s.world.planning).toBe(2));
    expect(
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'pause_run',
        runId,
        type: 'pause',
        payload: { scope: 'run' },
      }).status,
    ).not.toBe('rejected');
    hold.open();
    await vi.waitFor(() =>
      expect(s.authorized(runId).map((event) => event.payload.toolCallId)).toEqual([
        auth.toolCallId,
      ]),
    );
    expect(s.cancel(runId, writer.input.executionId).status).not.toBe('rejected');
    expect((await pending).ok).toBe(false);
    expect(s.runCommand).toHaveBeenCalledTimes(1);
    expect(s.approvals(runId)).toHaveLength(1);
  });

  it.each([
    ['pins the same harness passes on the grant', 1, 'a'.repeat(64), 0],
    ['pins another policy revision asks again', 2, 'a'.repeat(64), 1],
    ['pins another harness snapshot asks again', 1, 'b'.repeat(64), 1],
  ] as const)(
    'a later execution of the Run whose role %s for the same command',
    async (_name, editorRevision, editorSnapshot, asks) => {
      const s = commandSetup({
        agents: ['writer', 'editor'],
        resolve: (roleId) =>
          roleId === 'editor_role' ? harness(editorRevision, editorSnapshot) : harness(),
      });
      const runId = s.start();
      const writer = await s.next(0);
      await s.call(runId, writer, command(), 'run');
      await s.finish(writer);
      const editor = await s.next(1);
      expect(editor.input.harness?.snapshotHash).toBe(editorSnapshot);
      const later = await s.call(runId, editor, command(), asks ? 'once' : undefined);
      expect(later.outcome.ok).toBe(true);
      expect(later.newApprovals).toBe(asks);
      expect(s.authorized(runId)).toHaveLength(1 - asks);
      // The launch is the same; only the registration and policy around it differ.
      expect(s.plans[1]!.launchFingerprint).toBe(s.plans[0]!.launchFingerprint);
      editor.settle({ outcome: 'cancelled' });
    },
  );

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
