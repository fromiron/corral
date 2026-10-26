import type { AgentAdapter, AgentHost, AgentSettlement, RunCommand } from '@corral/contracts';
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
