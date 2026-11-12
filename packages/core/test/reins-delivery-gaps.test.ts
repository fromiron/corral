import {
  type AgentAdapter,
  type AgentHost,
  type AgentSettlement,
  type AgentStartInput,
  type CorralDefinition,
  canonicalJson,
  type DeliveredDirective,
  type EffectiveHarnessSnapshot,
  type RunCommand,
  type ToolDescriptor,
} from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  exportRunArchive,
  type FileTools,
  InMemoryRunStore,
  InProcessTransport,
  usageTotals,
  waitForProjection,
} from '../src/index.ts';
import { readPartialOutputs } from '../src/partial-output.ts';

// Directive delivery paths no other test pins (docs/specs/features/reins.md §2 and §5): a target
// that has not started, one waiting on the person, one that ends or is stopped before it reads
// the directive, a cut call's usage, and a target that has already finished.

interface Started {
  input: AgentStartInput;
  host: AgentHost;
  /** What the host had queued for this execution when its agent started. */
  pendingAtStart: DeliveredDirective[];
  settle: (settlement: AgentSettlement) => void;
}

const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
const descriptor = (name: string, sideEffect: ToolDescriptor['sideEffect']): ToolDescriptor => ({
  name,
  source: 'corral',
  schemaHash: hash({ name }),
  exposure: 'direct',
  sideEffect,
});
const writeFile = descriptor('write_file', 'workspace');
const bookkeeping = [
  descriptor('write_artifact', 'workspace'),
  descriptor('submit_result', 'workspace'),
];
/** A harness under which every file write asks the person first. */
const askingHarness = (): EffectiveHarnessSnapshot => ({
  binding: { profileId: 'writing', revision: 1 },
  snapshotHash: 'a'.repeat(64),
  piVersion: '1.3.0',
  policyRevision: 1,
  policy: 'trusted-native',
  resources: [],
  allowedTools: ['write_file', 'write_artifact', 'submit_result'],
  tools: [],
  diagnostics: [],
  permissionPolicies: [
    {
      default: 'ask',
      rules: bookkeeping.map((tool) => ({
        tool: tool.name,
        action: 'allow' as const,
        descriptorHash: hash(tool),
      })),
    },
  ],
});

function setup(
  options: {
    /** Holds every agent start until opened: the execution exists, its worker does not. */
    startGate?: Gate;
    /** Whether the adapter's handles take an interrupt. */
    interrupts?: boolean;
    /** Roles bound to a harness that asks before each file write. */
    approvals?: boolean;
    definition?: () => CorralDefinition;
  } = {},
) {
  const store = new InMemoryRunStore();
  const started: Started[] = [];
  const pushed: DeliveredDirective[] = [];
  const interrupted: DeliveredDirective[] = [];
  const agents: AgentAdapter = {
    async start(input, host) {
      await options.startGate?.wait();
      let settle!: (settlement: AgentSettlement) => void;
      const settled = new Promise<AgentSettlement>((resolve) => (settle = resolve));
      started.push({ input, host, settle, pendingAtStart: host.pendingDirectives?.() ?? [] });
      return {
        cancel: async () => settle({ outcome: 'cancelled' }),
        waitForSettlement: () => settled,
        pushDirective: (directive) => void pushed.push(directive),
        ...(options.interrupts
          ? { interrupt: (directive: DeliveredDirective) => void interrupted.push(directive) }
          : {}),
      };
    },
  };
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents,
    ...(options.approvals
      ? {
          files: {
            available: () => true,
            execute: async (value: { args: { path: string } }) => ({
              path: value.args.path,
              created: true,
            }),
          } as unknown as FileTools,
          harnesses: { resolve: () => askingHarness() },
        }
      : {}),
  });
  const transport = new InProcessTransport(coordinator);
  const definition = options.definition?.() ?? linearCorral(['writer']);
  if (options.approvals)
    for (const role of definition.roles) {
      role.harness = askingHarness().binding;
      role.allowedWorkTools = ['write_artifact', 'write_file'];
    }
  const { runId, receipt } = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'mock',
    definition,
  });
  if (!runId) throw new Error(receipt.error?.message ?? 'the run did not start');
  const send = (type: RunCommand['type'], payload: unknown, commandId: string = type) =>
    coordinator.submit({
      schemaVersion: '0.1',
      runId,
      commandId,
      type,
      payload,
      expectedControlRevision: coordinator.getSnapshot(runId).projection.controlRevision,
    } as RunCommand);
  const steer = (
    targetExecutionId: string,
    text: string,
    commandId: string,
    delivery: 'next_request' | 'interrupt' = 'next_request',
  ) => send('steer', { targetExecutionId, text, delivery }, commandId);
  const projection = () => coordinator.getSnapshot(runId).projection;
  const events = () => store.readEvents(runId, 0);
  const directive = (commandId: string) => {
    const id = store.getCommand(runId, commandId)?.directiveId;
    return id ? projection().directives[id] : undefined;
  };
  /** The nth agent, once it started. */
  const agent = async (index: number): Promise<Started> => {
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(index));
    const value = started[index];
    if (!value) throw new Error('the agent did not start');
    return value;
  };
  const firstExecution = async () =>
    (await waitForProjection(transport, runId, (p) => p.executionOrder.length === 1))
      .executionOrder[0] ?? '';
  /** One whole request of this agent: prepared, dispatched, answered. */
  const request = async (host: AgentHost) => {
    // A harness role reports what its request carries, as the SDK worker does.
    const permit = await host.prepareModelRequest(
      options.approvals
        ? {
            purpose: 'turn',
            directiveIds: (host.pendingDirectives?.() ?? []).map((d) => d.directiveId),
            contextHash: 'd'.repeat(64),
            contextBytes: 250,
            sections: [],
          }
        : undefined,
    );
    await host.modelRequestDispatched?.(permit.modelCallId);
    await host.observe({
      kind: 'model_completed',
      modelCallId: permit.modelCallId,
      text: 'reply',
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    return permit;
  };
  /** The agent writes and submits a result and ends. */
  const succeed = async (agent: Started) => {
    const written = await agent.host.invokeTool({
      name: 'write_artifact',
      args: { text: 'Result' },
    });
    if (!written.ok) throw new Error(written.error.message);
    const submitted = await agent.host.invokeTool({
      name: 'submit_result',
      args: { artifactVersionIds: [written.result.artifactVersionId] },
    });
    if (!submitted.ok) throw new Error(submitted.error.message);
    agent.settle({ outcome: 'succeeded' });
  };
  return {
    coordinator,
    transport,
    store,
    runId,
    started,
    pushed,
    interrupted,
    send,
    steer,
    projection,
    events,
    directive,
    agent,
    firstExecution,
    request,
    succeed,
  };
}

describe('a target whose worker has not started', () => {
  it('directives sent before the worker starts stay queued and ride its first request, in arrival order', async () => {
    const gate = new Gate();
    const s = setup({ startGate: gate });
    const executionId = await s.firstExecution();
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    expect(s.steer(executionId, 'Keep the API.', 'first').status).toBe('queued');
    expect(s.steer(executionId, 'Cite sources.', 'second').status).toBe('queued');
    const first = s.directive('first');
    const second = s.directive('second');
    expect([first?.status, second?.status]).toEqual(['queued', 'queued']);
    gate.open();
    const writer = await s.agent(0);
    const ids = [first?.directiveId, second?.directiveId];
    expect(writer.pendingAtStart.map((d) => d.directiveId)).toEqual(ids);
    expect(writer.pendingAtStart.map((d) => d.text)).toEqual(['Keep the API.', 'Cite sources.']);
    const permit = await writer.host.prepareModelRequest();
    expect(permit.directives.map((d) => d.directiveId)).toEqual(ids);
    await writer.host.modelRequestDispatched?.(permit.modelCallId);
    expect(s.projection().modelCalls[permit.modelCallId]?.directiveIds).toEqual(ids);
    expect([s.directive('first')?.status, s.directive('second')?.status]).toEqual([
      'delivered',
      'delivered',
    ]);
    expect(s.coordinator.getReceipt(s.runId, 'first')?.status).toBe('applied');
    expect(s.coordinator.getReceipt(s.runId, 'second')?.status).toBe('applied');
  });

  it('an interrupt sent before the adapter hands the worker over is lowered, even for an adapter that can interrupt, and the receipt says so', async () => {
    const gate = new Gate();
    const s = setup({ startGate: gate, interrupts: true });
    const executionId = await s.firstExecution();
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    const receipt = s.steer(executionId, 'Stop and cite.', 'early', 'interrupt');
    gate.open();
    await s.agent(0);
    expect(receipt).toMatchObject({ status: 'queued', requestedBoundary: 'next_request' });
    expect(s.events().find((e) => e.type === 'directive.accepted')?.payload.delivery).toBe(
      'next_request',
    );
    expect(s.interrupted).toEqual([]);
  });
});

describe('a target waiting on the person', () => {
  /** The writer asks to write a file and waits for the person's decision. */
  const waitingForApproval = async () => {
    const s = setup({ approvals: true });
    const writer = await s.agent(0);
    await writer.host.reportHarness?.({
      ok: true,
      snapshotHash: writer.input.harness?.snapshotHash ?? '',
      tools: [writeFile, ...bookkeeping],
      diagnostics: [],
    });
    const executionId = writer.input.executionId;
    const auth = await writer.host.authorizeTool({
      name: 'write_file',
      args: { path: 'notes.md', text: 'notes' },
    });
    if (!auth.ok) throw new Error(auth.error.message);
    const outcome = writer.host.executeTool(auth.toolCallId);
    await waitForProjection(
      s.transport,
      s.runId,
      (p) => p.executions[executionId]?.status === 'waiting_approval',
    );
    const approvalId =
      Object.values(s.projection().approvals).find((a) => a.status === 'pending')?.approvalId ?? '';
    const decide = (decision: 'approve' | 'reject') =>
      s.send(
        'resolve_approval',
        {
          approvalId,
          decision,
          subjectVersionId: s.projection().approvals[approvalId]?.subjectVersionIds[0],
        },
        `resolve_${decision}`,
      );
    return { s, writer, executionId, outcome, decide };
  };

  it('a directive sent during a tool approval stays queued and rides the first request after the approval', async () => {
    const { s, writer, executionId, outcome, decide } = await waitingForApproval();
    expect(s.steer(executionId, 'Keep the API.', 'during').status).toBe('queued');
    expect(s.directive('during')?.status).toBe('queued');
    expect(decide('approve').status).toBe('applied');
    expect((await outcome).ok).toBe(true);
    expect(s.directive('during')?.status).toBe('queued');
    const permit = await s.request(writer.host);
    expect(permit.directives.map((d) => d.directiveId)).toEqual([
      s.directive('during')?.directiveId,
    ]);
    expect(s.directive('during')?.status).toBe('delivered');
  });

  it('a directive sent during a tool approval rides the first request after a rejection, as the target goes on', async () => {
    const { s, writer, executionId, outcome, decide } = await waitingForApproval();
    s.steer(executionId, 'Keep the API.', 'during');
    expect(decide('reject').status).toBe('applied');
    expect((await outcome).ok).toBe(false);
    expect(s.directive('during')?.status).toBe('queued');
    const permit = await s.request(writer.host);
    expect(permit.directives.map((d) => d.directiveId)).toEqual([
      s.directive('during')?.directiveId,
    ]);
    expect(s.directive('during')?.status).toBe('delivered');
  });

  it('a directive sent during a tool approval expires when the target ends failed after a rejection', async () => {
    const { s, writer, executionId, outcome, decide } = await waitingForApproval();
    s.steer(executionId, 'Keep the API.', 'during');
    decide('reject');
    await outcome;
    writer.settle({ outcome: 'failed', error: 'the write was refused' });
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'failed');
    expect(s.directive('during')?.status).toBe('expired');
    expect(s.coordinator.getReceipt(s.runId, 'during')?.status).toBe('expired');
  });
});

describe('a target that ends before it reads the directive', () => {
  it('a directive whose target fails before another request expires', async () => {
    const s = setup();
    const writer = await s.agent(0);
    const executionId = writer.input.executionId;
    await s.request(writer.host);
    s.steer(executionId, 'Keep the API.', 'late');
    writer.settle({ outcome: 'failed', error: 'model error' });
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'failed');
    expect(s.directive('late')?.status).toBe('expired');
    expect(s.coordinator.getReceipt(s.runId, 'late')?.status).toBe('expired');
    expect(
      s
        .events()
        .filter((e) => e.type === 'directive.undelivered')
        .map((e) => e.payload),
    ).toMatchObject([{ status: 'expired' }]);
  });

  it('a directive whose target the person cancels before another request is not delivered', async () => {
    const s = setup();
    const writer = await s.agent(0);
    const executionId = writer.input.executionId;
    s.steer(executionId, 'Keep the API.', 'late');
    s.send('cancel', { scope: { kind: 'execution', executionId }, reason: 'stopped' }, 'stop');
    expect(s.directive('late')?.status).toBe('not_delivered');
    await waitForProjection(s.transport, s.runId, (p) =>
      ['cancelled', 'failed'].includes(p.executions[executionId]?.status ?? ''),
    );
    expect(s.directive('late')?.status).toBe('not_delivered');
    expect(s.coordinator.getReceipt(s.runId, 'late')?.status).toBe('cancelled');
  });

  it('a directive whose run the person cancels before another request is not delivered', async () => {
    const s = setup();
    const writer = await s.agent(0);
    s.steer(writer.input.executionId, 'Keep the API.', 'late');
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stopped' }, 'stop');
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'cancelled');
    expect(s.directive('late')?.status).toBe('not_delivered');
  });

  it('a directive on a request whose start was never seen is delivery_unknown when the target ends', async () => {
    const s = setup();
    const writer = await s.agent(0);
    s.steer(writer.input.executionId, 'Keep the API.', 'late');
    await writer.host.prepareModelRequest();
    expect(s.directive('late')?.status).toBe('attached_to_request');
    writer.settle({ outcome: 'failed', error: 'the connection dropped' });
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'failed');
    expect(s.directive('late')?.status).toBe('delivery_unknown');
  });
});

describe('a paused target', () => {
  /** The writer finishes one request under a pause and holds its next one at the boundary. */
  const paused = async () => {
    const s = setup();
    const writer = await s.agent(0);
    const first = await writer.host.prepareModelRequest();
    s.send('pause', { scope: 'run' }, 'pause');
    await writer.host.observe({
      kind: 'model_completed',
      modelCallId: first.modelCallId,
      text: 'first',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const next = writer.host.prepareModelRequest();
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'paused');
    return { s, writer, next };
  };

  it('a directive sent during a pause stays queued and rides the first request after resume', async () => {
    const { s, writer, next } = await paused();
    expect(s.steer(writer.input.executionId, 'Keep the API.', 'paused').status).toBe('queued');
    expect(s.directive('paused')?.status).toBe('queued');
    expect(s.send('resume', { scope: 'run' }, 'resume').status).toBe('applied');
    const permit = await next;
    expect(permit.directives.map((d) => d.directiveId)).toEqual([
      s.directive('paused')?.directiveId,
    ]);
    await writer.host.modelRequestDispatched?.(permit.modelCallId);
    expect(s.directive('paused')?.status).toBe('delivered');
  });

  it('a directive sent during a pause is not delivered when the person cancels the run', async () => {
    const { s, writer, next } = await paused();
    s.steer(writer.input.executionId, 'Keep the API.', 'paused');
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stopped' }, 'stop');
    await expect(next).rejects.toThrow();
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'cancelled');
    expect(s.directive('paused')?.status).toBe('not_delivered');
  });
});

describe("a cut call's usage", () => {
  const cutRun = async (usage: { inputTokens: number | null; outputTokens: number | null }) => {
    const s = setup({ interrupts: true });
    const writer = await s.agent(0);
    const cut = await writer.host.prepareModelRequest();
    await writer.host.modelRequestDispatched?.(cut.modelCallId);
    s.steer(writer.input.executionId, 'Stop and cite.', 'cut', 'interrupt');
    await writer.host.observe({
      kind: 'model_completed',
      modelCallId: cut.modelCallId,
      text: 'partial',
      usage,
      interrupted: true,
    });
    await s.request(writer.host);
    return { s, cut };
  };

  it('a call cut by an interrupt keeps its reported usage in the run total', async () => {
    const { s, cut } = await cutRun({ inputTokens: 5, outputTokens: 3 });
    expect(s.projection().modelCalls[cut.modelCallId]?.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 3,
    });
    // The cut call (3) and the whole call after it (1).
    expect(usageTotals(s.projection())).toMatchObject({ requests: 2, outputTokens: 4, unknown: 0 });
  });

  it('a call cut by an interrupt without reported usage counts as unknown, not zero', async () => {
    const { s } = await cutRun({ inputTokens: null, outputTokens: null });
    expect(usageTotals(s.projection())).toMatchObject({ requests: 2, outputTokens: 1, unknown: 1 });
  });
});

describe('a target that has finished', () => {
  it('a steer to a finished execution is refused and reaches no other target or request', async () => {
    const s = setup({ definition: () => linearCorral(['research', 'writer']) });
    const research = await s.agent(0);
    await s.request(research.host);
    await s.succeed(research);
    const writer = await s.agent(1);
    const receipt = s.steer(research.input.executionId, 'Keep the API.', 'late');
    expect(receipt.status).toBe('rejected');
    expect(receipt.error?.code).toBe('TARGET_TERMINAL');
    expect(s.events().some((e) => e.type === 'directive.accepted')).toBe(false);
    expect(s.projection().directiveOrder).toEqual([]);
    expect(writer.pendingAtStart).toEqual([]);
    expect(writer.host.pendingDirectives?.()).toEqual([]);
    expect(s.pushed).toEqual([]);
    const permit = await s.request(writer.host);
    expect(permit.directives).toEqual([]);
  });
});

describe('an unfinished call', () => {
  /** One call streams two chunks and ends with the given mark; then the person stops the run. */
  const unfinished = async (mark: { interrupted: true } | { failed: true }) => {
    const s = setup({ interrupts: true });
    const writer = await s.agent(0);
    const permit = await writer.host.prepareModelRequest();
    await writer.host.modelRequestDispatched?.(permit.modelCallId);
    writer.host.streamText({ modelCallId: permit.modelCallId, chunkIndex: 0, text: 'UNFINISHED ' });
    writer.host.streamText({ modelCallId: permit.modelCallId, chunkIndex: 1, text: 'prefix' });
    await writer.host.observe({
      kind: 'model_completed',
      modelCallId: permit.modelCallId,
      text: 'UNFINISHED prefix',
      usage: { inputTokens: 4, outputTokens: 2 },
      ...mark,
    });
    const finished = s.events().find((e) => e.type === 'model.finished');
    const whole = await s.request(writer.host);
    // Response bodies as stored while the run is live (an ended run releases unretained ones).
    const bodies = {
      call: s.store.getArtifactText(s.runId, `response_${permit.modelCallId}`),
      whole: s.store.getArtifactText(s.runId, `response_${whole.modelCallId}`),
    };
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stopped' }, 'stop');
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'cancelled');
    return { s, call: permit.modelCallId, whole: whole.modelCallId, finished, bodies };
  };

  it.each([
    ['cut by an interrupt', { interrupted: true as const }],
    ['ended in an error', { failed: true as const }],
  ])(
    'a call %s records no confirmed response; its text is partial output only, also on replay, and no response body reaches history, branches or search',
    async (_name, mark) => {
      const { s, call, whole, finished, bodies } = await unfinished(mark);
      expect(finished?.payload).toMatchObject({
        responseRef: null,
        certainty: 'reported',
        normalizedUsage: { inputTokens: 4, outputTokens: 2 },
      });
      expect(s.projection().modelCalls[call]).toMatchObject({ finished: true, responseRef: null });
      expect(s.projection().modelCalls[whole]?.responseRef).toBe(`response_${whole}`);
      expect(s.coordinator.getSnapshot(s.runId).partialOutputs?.[call]?.text).toBe(
        'UNFINISHED prefix',
      );
      // Rebuilt from the record, the projection and the partial output are the same.
      const replayed = s.events().reduce(applyEvent, emptyProjection(s.runId));
      expect(replayed).toEqual(s.projection());
      expect(readPartialOutputs(s.store, s.runId, replayed)?.[call]?.text).toBe(
        'UNFINISHED prefix',
      );
      // Branch history and session search read a call's text through its response body; the
      // whole call has one, the unfinished call none. The private history names only the whole.
      expect(bodies).toEqual({ call: null, whole: 'reply' });
      const archive = exportRunArchive(s.store, s.runId, { privateTranscript: true });
      const refs = 'unavailableBodyRefs' in archive ? archive.unavailableBodyRefs : [];
      expect(refs).toContain(`response_${whole}`);
      expect(refs).not.toContain(`response_${call}`);
      // Neither export carries the partial text (true of any reply text, kept as a guard).
      for (const privateTranscript of [false, true])
        expect(
          JSON.stringify(exportRunArchive(s.store, s.runId, { privateTranscript })),
        ).not.toContain('UNFINISHED');
    },
  );
});
