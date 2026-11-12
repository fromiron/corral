import type {
  AgentAdapter,
  AgentHost,
  AgentSettlement,
  DeliveredDirective,
  RunCommand,
} from '@corral/contracts';
import {
  collaborationCorral,
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it, vi } from 'vitest';
import {
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

function setup() {
  const store = new InMemoryRunStore();
  const hosts: AgentHost[] = [];
  const exits: ((value: AgentSettlement) => void)[] = [];
  const agents: AgentAdapter = {
    async start(_input, host) {
      hosts.push(host);
      const settled = new Promise<AgentSettlement>((resolve) => exits.push(resolve));
      return { cancel: async () => {}, waitForSettlement: () => settled };
    },
  };
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents,
  });
  const transport = new InProcessTransport(coordinator);
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  const runId = result.runId;
  if (!runId) throw new Error('the Reins fixture run did not start');
  const send = (
    type: RunCommand['type'],
    payload: unknown,
    commandId: string = type,
    expectedControlRevision?: number,
  ) =>
    coordinator.submit({
      schemaVersion: '0.1',
      runId,
      commandId,
      type,
      payload,
      ...(expectedControlRevision === undefined ? {} : { expectedControlRevision }),
    } as RunCommand);
  return { coordinator, transport, runId, hosts, exits, send, store };
}

describe('P6 Reins boundaries', () => {
  it('receipt reads skip history before their directive without losing delivery evidence', async () => {
    const s = setup();
    const p = await waitForProjection(s.transport, s.runId, (p) => p.executionOrder.length === 1);
    const host = s.hosts[0];
    if (!host) throw new Error('the first agent did not start');
    const before = s.store.readEvents(s.runId, 0).length;
    const read = vi.spyOn(s.store, 'readEvents');
    const receipt = s.send('steer', {
      targetExecutionId: p.executionOrder[0],
      text: 'Use evidence',
      delivery: 'next_request',
    });
    expect(receipt.status).toBe('queued');
    expect(read.mock.calls.every(([, after]) => after >= before)).toBe(true);
    const permit = await host.prepareModelRequest();
    await host.modelRequestDispatched?.(permit.modelCallId);
    read.mockClear();
    const applied = s.coordinator.getReceipt(s.runId, 'steer');
    expect(applied?.status).toBe('applied');
    expect(read.mock.calls.every(([, after]) => after >= before)).toBe(true);
    read.mockRestore();
    expect(applied?.relatedEventIds).toEqual(
      s.store
        .readEvents(s.runId, 0)
        .filter((e) => e.type.startsWith('directive.'))
        .map((e) => e.eventId),
    );
  });
  it('prepared is attached, dispatch is delivered, terminal fences reject new effects', async () => {
    const s = setup();
    const p = await waitForProjection(s.transport, s.runId, (p) => p.executionOrder.length === 1);
    const executionId = p.executionOrder[0];
    if (!executionId) throw new Error('the first execution was not created');
    s.send('steer', { targetExecutionId: executionId, text: 'evidence', delivery: 'next_request' });
    const host = s.hosts[0];
    const exit = s.exits[0];
    if (!host || !exit) throw new Error('the first agent did not start');
    const permit = await host.prepareModelRequest();
    expect(Object.values(s.coordinator.getSnapshot(s.runId).projection.directives)[0]?.status).toBe(
      'attached_to_request',
    );
    await host.modelRequestDispatched?.(permit.modelCallId);
    expect(s.coordinator.getReceipt(s.runId, 'steer')?.status).toBe('applied');
    const receipt = s.send('cancel', { scope: { kind: 'run' }, reason: 'done' });
    expect(receipt.status).toBe('accepted');
    expect(s.coordinator.getSnapshot(s.runId).projection.status).toBe('cancelling');
    const fencedEffects = Object.keys(s.coordinator.getSnapshot(s.runId).projection.effects);
    await expect(host.prepareModelRequest()).rejects.toThrow();
    await expect(
      host.invokeTool({ name: 'write_artifact', args: { text: 'late write' } }),
    ).rejects.toThrow();
    expect(Object.keys(s.coordinator.getSnapshot(s.runId).projection.effects)).toEqual(
      fencedEffects,
    );
    exit({ outcome: 'cancelled' });
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'cancelled');
    expect(s.coordinator.getReceipt(s.runId, 'cancel')?.status).toBe('applied');
  });
  it('pause drains a request and queues the next boundary until resume', async () => {
    const s = setup();
    await waitForProjection(s.transport, s.runId, (p) => p.executionOrder.length === 1);
    const host = s.hosts[0];
    if (!host) throw new Error('the first agent did not start');
    const first = await host.prepareModelRequest();
    expect(s.send('pause', { scope: 'run' }).status).toBe('accepted');
    expect(s.coordinator.getSnapshot(s.runId).projection.status).toBe('pausing');
    await host.observe({
      kind: 'model_completed',
      modelCallId: first.modelCallId,
      text: 'first',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const next = host.prepareModelRequest();
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'paused');
    expect(Object.keys(s.coordinator.getSnapshot(s.runId).projection.modelCalls)).toHaveLength(1);
    expect(s.send('resume', { scope: 'run' }).status).toBe('applied');
    expect((await next).modelCallId).not.toBe(first.modelCallId);
  });
  it('future patch commits revision, keeps the base immutable, and rejects stale controls', async () => {
    const s = setup();
    await waitForProjection(s.transport, s.runId, (p) => p.executionOrder.length === 1);
    const payload = { kind: 'node_future', nodeId: 'writer', prompt: 'Use primary evidence' };
    expect(s.send('patch', payload, 'patch', 0).status).toBe('applied');
    expect(s.coordinator.getSnapshot(s.runId).projection.controlRevision).toBe(1);
    expect(s.send('patch', payload, 'stale', 0).error?.code).toBe('STALE_CONTROL_REVISION');
    expect(s.coordinator.getRunSnapshot(s.runId)?.definition.roles[0]?.prompt).not.toBe(
      payload.prompt,
    );
  });
});

it('node patches freeze active executions and apply only to a future activation of that node', async () => {
  const definition = linearCorral(['first', 'second']);
  const firstNode = definition.nodes.find((n) => n.id === 'first');
  const secondNode = definition.nodes.find((n) => n.id === 'second');
  if (firstNode?.type !== 'agent' || secondNode?.type !== 'agent') throw new Error('fixture');
  secondNode.roleId = firstNode.roleId;
  const inputs: import('@corral/contracts').AgentStartInput[] = [];
  const hosts: AgentHost[] = [];
  const exits: ((s: AgentSettlement) => void)[] = [];
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: {
      async start(input, host) {
        inputs.push(input);
        hosts.push(host);
        const result = new Promise<AgentSettlement>((resolve) => exits.push(resolve));
        return { cancel: async () => {}, waitForSettlement: () => result };
      },
    },
  });
  const transport = new InProcessTransport(coordinator);
  const { runId } = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error('the node patch fixture run did not start');
  await waitForProjection(transport, runId, (p) => p.executionOrder.length === 1);
  const firstInput = inputs[0];
  const firstHost = hosts[0];
  const finishFirst = exits[0];
  if (!firstInput || !firstHost || !finishFirst) throw new Error('the first agent did not start');
  expect(
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'patch',
      runId,
      type: 'patch',
      expectedControlRevision: 0,
      payload: { kind: 'node_future', nodeId: 'second', prompt: 'Changed future node only' },
    }).status,
  ).toBe('applied');
  expect(
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'patch-active',
      runId,
      type: 'patch',
      expectedControlRevision: 1,
      payload: { kind: 'node_future', nodeId: 'first', prompt: 'Changed active node future' },
    }).status,
  ).toBe('applied');
  expect(firstInput.role.prompt).not.toBe('Changed active node future');
  expect(firstInput.role.prompt).not.toBe('Changed future node only');
  expect(coordinator.getSnapshot(runId).projection.patches.patch?.executionIds).toEqual([]);
  const first = await firstHost.prepareModelRequest();
  await firstHost.observe({
    kind: 'model_completed',
    modelCallId: first.modelCallId,
    text: 'draft',
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const written = await firstHost.invokeTool({
    name: 'write_artifact',
    args: { text: 'first draft' },
  });
  if (!written.ok) throw new Error('write');
  await firstHost.invokeTool({
    name: 'submit_result',
    args: { artifactVersionIds: [written.result.artifactVersionId] },
  });
  finishFirst({ outcome: 'succeeded' });
  await waitForProjection(transport, runId, (p) => p.executionOrder.length === 2);
  const secondInput = inputs[1];
  if (!secondInput) throw new Error('the second agent did not start');
  expect(secondInput.role.prompt).toBe('Changed future node only');
  expect(
    coordinator.getSnapshot(runId).projection.modelCalls[first.modelCallId]?.configRevision,
  ).toBe(0);
  const projection = coordinator.getSnapshot(runId).projection;
  expect(projection.patches.patch?.executionIds).toEqual([secondInput.executionId]);
  expect(projection.executions[secondInput.executionId]?.configRevision).toBe(1);
});

it('patch allows only a future prompt or profile and cannot change graph or permissions', async () => {
  const s = setup();
  await waitForProjection(s.transport, s.runId, (p) => p.executionOrder.length === 1);
  for (const forbidden of [
    { allowedWorkTools: ['search'] },
    { roleId: 'admin' },
    { controlEdges: [] },
    { nodeId: 'writer', allowedCollaborationTools: ['spawn_subagents'] },
  ]) {
    const receipt = s.send(
      'patch',
      { kind: 'node_future', nodeId: 'writer', prompt: 'new prompt', ...forbidden },
      `forbidden_${Object.keys(forbidden).join('_')}`,
      0,
    );
    expect(receipt.error?.code).toBe('SCHEMA_INVALID');
  }
  expect(s.coordinator.getSnapshot(s.runId).projection.controlRevision).toBe(0);
  expect(
    s.send(
      'patch',
      { kind: 'node_future', nodeId: 'writer', prompt: 'allowed prompt' },
      'allowed',
      0,
    ).status,
  ).toBe('applied');
  expect(s.coordinator.getSnapshot(s.runId).projection.controlRevision).toBe(1);
});

it('a parent waiting for children holds no request slot and does not delay pause at child boundaries', async () => {
  const reply = new Gate();
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      beforeReply: async (_turn, input) => {
        if (input.nodeId === 'helper') await reply.wait();
      },
    }),
  });
  const transport = new InProcessTransport(coordinator);
  const runId = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'mock',
    definition: collaborationCorral(),
  }).runId;
  if (!runId) throw new Error('no run');
  await waitForProjection(
    transport,
    runId,
    (p) =>
      Object.values(p.executions).some((e) => e.status === 'waiting_children') &&
      Object.keys(p.modelCalls).length === 2,
  );
  coordinator.submit({
    schemaVersion: '0.1',
    runId,
    commandId: 'pause',
    type: 'pause',
    payload: { scope: 'run' },
  });
  reply.open();
  const paused = await waitForProjection(transport, runId, (p) => p.status === 'paused');
  expect(
    Object.values(paused.executions).filter((e) => e.status === 'waiting_children'),
  ).toHaveLength(1);
  expect(Object.values(paused.executions).filter((e) => e.status === 'paused')).toHaveLength(2);
  expect(
    Object.values(paused.effects).filter(
      (e) => e.kind === 'model_request' && e.status === 'admitted',
    ),
  ).toHaveLength(0);
  coordinator.submit({
    schemaVersion: '0.1',
    runId,
    commandId: 'resume',
    type: 'resume',
    payload: { scope: 'run' },
  });
  expect((await waitForProjection(transport, runId, (p) => p.status === 'succeeded')).status).toBe(
    'succeeded',
  );
});

describe('interrupt delivery', () => {
  function interruptSetup(options: { interrupts: boolean; askUser?: boolean }) {
    const store = new InMemoryRunStore();
    const hosts: AgentHost[] = [];
    const interrupts: DeliveredDirective[] = [];
    const pushed: DeliveredDirective[] = [];
    const agents: AgentAdapter = {
      async start(_input, host) {
        hosts.push(host);
        const settled = new Promise<AgentSettlement>(() => {});
        return {
          cancel: async () => {},
          waitForSettlement: () => settled,
          pushDirective: (directive) => void pushed.push(directive),
          ...(options.interrupts
            ? { interrupt: (directive: DeliveredDirective) => void interrupts.push(directive) }
            : {}),
        };
      },
    };
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents,
    });
    const transport = new InProcessTransport(coordinator);
    const definition = linearCorral(['writer']);
    if (options.askUser) definition.roles[0]?.allowedCollaborationTools.push('ask_user');
    const { runId } = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'mock',
      definition,
    });
    if (!runId) throw new Error('the interrupt fixture run did not start');
    const steer = (targetExecutionId: string, commandId = 'interrupt') =>
      coordinator.submit({
        schemaVersion: '0.1',
        runId,
        commandId,
        type: 'steer',
        payload: { targetExecutionId, text: 'Stop and cite sources.', delivery: 'interrupt' },
      });
    const accepted = () =>
      store.readEvents(runId, 0).filter((event) => event.type === 'directive.accepted');
    const started = async () => {
      const p = await waitForProjection(transport, runId, (p) => p.executionOrder.length === 1);
      await vi.waitFor(() => expect(hosts).toHaveLength(1));
      const host = hosts[0];
      if (!host) throw new Error('the agent did not start');
      return { executionId: p.executionOrder[0] ?? '', host };
    };
    return { coordinator, transport, runId, interrupts, pushed, steer, accepted, store, started };
  }

  it('an interrupt is accepted, reaches the handle once, and is delivered by the next request', async () => {
    const s = interruptSetup({ interrupts: true });
    const { executionId, host } = await s.started();
    const receipt = s.steer(executionId);
    expect(receipt).toMatchObject({ status: 'queued', requestedBoundary: 'immediate' });
    expect(s.accepted().map((event) => event.payload)).toMatchObject([{ delivery: 'interrupt' }]);
    const directiveId = Object.keys(s.coordinator.getSnapshot(s.runId).projection.directives)[0];
    expect(s.interrupts).toEqual([{ directiveId, text: 'Stop and cite sources.' }]);
    expect(s.pushed).toEqual([]);
    // The same command sent again is the same intent: one directive, one interrupt.
    expect(s.steer(executionId)).toEqual(receipt);
    expect(s.accepted()).toHaveLength(1);
    expect(s.interrupts).toHaveLength(1);
    const permit = await host.prepareModelRequest();
    expect(permit.directives.map((d) => d.directiveId)).toEqual([directiveId]);
    await host.modelRequestDispatched?.(permit.modelCallId);
    expect(
      s.coordinator.getSnapshot(s.runId).projection.directives[directiveId ?? '']?.status,
    ).toBe('delivered');
    expect(s.coordinator.getReceipt(s.runId, 'interrupt')).toMatchObject({
      status: 'applied',
      requestedBoundary: 'immediate',
    });
  });

  it('the run projection marks a model call cut by an interrupt, and only that one', async () => {
    const s = interruptSetup({ interrupts: true });
    const { host } = await s.started();
    const usage = { inputTokens: 3, outputTokens: 1 };
    const cut = await host.prepareModelRequest();
    await host.modelRequestDispatched?.(cut.modelCallId);
    await host.observe({
      kind: 'model_completed',
      modelCallId: cut.modelCallId,
      text: 'partial',
      usage,
      interrupted: true,
    });
    const whole = await host.prepareModelRequest();
    await host.modelRequestDispatched?.(whole.modelCallId);
    await host.observe({
      kind: 'model_completed',
      modelCallId: whole.modelCallId,
      text: 'x',
      usage,
    });
    const calls = s.coordinator.getSnapshot(s.runId).projection.modelCalls;
    expect(calls[cut.modelCallId]?.interrupted).toBe(true);
    expect(calls[whole.modelCallId]).not.toHaveProperty('interrupted');
  });

  it('an adapter that cannot interrupt gets the directive as next_request, and the receipt says so', async () => {
    const s = interruptSetup({ interrupts: false });
    const { executionId, host } = await s.started();
    const receipt = s.steer(executionId);
    expect(receipt).toMatchObject({ status: 'queued', requestedBoundary: 'next_request' });
    expect(s.accepted().map((event) => event.payload)).toMatchObject([
      { delivery: 'next_request' },
    ]);
    expect(s.pushed).toHaveLength(1);
    const permit = await host.prepareModelRequest();
    await host.modelRequestDispatched?.(permit.modelCallId);
    expect(s.coordinator.getReceipt(s.runId, 'interrupt')).toMatchObject({
      status: 'applied',
      requestedBoundary: 'next_request',
    });
  });

  it('an interrupt for a target waiting on the person cuts nothing and rides the first request after', async () => {
    const s = interruptSetup({ interrupts: true, askUser: true });
    const { executionId, host } = await s.started();
    const answer = host.invokeTool({
      name: 'ask_user',
      args: { key: 'format', questions: [{ id: 'format', kind: 'text', prompt: 'Which format?' }] },
    });
    const waiting = await waitForProjection(
      s.transport,
      s.runId,
      (p) => p.executions[executionId]?.status === 'waiting_approval',
    );
    const receipt = s.steer(executionId);
    // Not lowered: the adapter can interrupt; there is just no response to cut.
    expect(receipt).toMatchObject({ status: 'queued', requestedBoundary: 'immediate' });
    expect(s.accepted().map((event) => event.payload)).toMatchObject([{ delivery: 'interrupt' }]);
    expect(s.interrupts).toEqual([]);
    expect(s.pushed).toHaveLength(1);
    const event = s.store.readEvents(s.runId, 0).find((e) => e.type === 'user_input.requested');
    if (event?.type !== 'user_input.requested') throw new Error('missing request');
    expect(
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'answer',
        runId: s.runId,
        type: 'answer_user',
        expectedControlRevision: waiting.controlRevision,
        payload: {
          requestId: event.payload.requestId,
          executionId,
          attemptNo: 1,
          schemaHash: event.payload.schemaHash,
          answers: [{ questionId: 'format', text: 'A table' }],
        },
      }).status,
    ).toBe('applied');
    await answer;
    const permit = await host.prepareModelRequest();
    const directiveId = s.pushed[0]?.directiveId;
    expect(permit.directives.map((d) => d.directiveId)).toEqual([directiveId]);
    await host.modelRequestDispatched?.(permit.modelCallId);
    expect(
      s.coordinator.getSnapshot(s.runId).projection.directives[directiveId ?? '']?.status,
    ).toBe('delivered');
  });
});
