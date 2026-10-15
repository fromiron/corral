import { RunEvent, type StartRunRequest, type SteerCommand } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  directDirectivesForArtifact,
  emptyProjection,
  InMemoryCoordinator,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

function setup(options: { turns?: number; gates?: Gate[] } = {}) {
  const gates = options.gates ?? [];
  let replies = 0;
  const agents = new ScriptedAgentAdapter({
    turns: options.turns ?? 1,
    beforeReply: () => gates[replies++]?.wait() ?? Promise.resolve(),
  });
  const coordinator = new InMemoryCoordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents,
  });
  return new InProcessTransport(coordinator);
}

const startRequest = (agentIds: string[], commandId = 'cmd_start'): StartRunRequest => ({
  schemaVersion: '0.1',
  commandId,
  definition: linearCorral(agentIds),
  mode: 'mock',
});

const steer = (runId: string, executionId: string, commandId = 'cmd_steer'): SteerCommand => ({
  schemaVersion: '0.1',
  commandId,
  runId,
  type: 'steer',
  payload: {
    targetExecutionId: executionId,
    text: 'Primary sources only.',
    delivery: 'next_request',
  },
});

const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const executionOf = (p: RunProjection, nodeId: string) => p.nodeExecutions[nodeId]?.[0];

async function collectEvents(transport: InProcessTransport, runId: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const unsubscribe = transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
  await waitForProjection(transport, runId, settled);
  await Promise.resolve();
  unsubscribe();
  return events;
}

describe('InMemoryCoordinator: linear mock run', () => {
  it('runs agents in edge order and finalizes the last submitted version', async () => {
    const transport = setup();
    const { runId, receipt } = await transport.startRun(startRequest(['research', 'writer']));
    expect(receipt.status).toBe('applied');
    if (!runId) throw new Error('no run');
    const events = await collectEvents(transport, runId);
    const final = await waitForProjection(transport, runId, settled);

    expect(final.status).toBe('succeeded');
    const created = events
      .filter((e) => e.type === 'execution.created')
      .map((e) => e.payload.nodeId);
    expect(created).toEqual(['research', 'writer']);

    const writer = final.tasks[final.executions[executionOf(final, 'writer') ?? '']?.taskId ?? ''];
    expect(final.output?.artifactVersionIds).toEqual(writer?.submittedArtifactVersionIds);

    const researchVersion =
      final.tasks[final.executions[executionOf(final, 'research') ?? '']?.taskId ?? '']
        ?.submittedArtifactVersionIds[0];
    const writerText = await transport.getArtifactText(
      runId,
      final.output?.artifactVersionIds[0] ?? '',
    );
    expect(writerText).toContain(`previous@${researchVersion}`);
  });

  it('emits schema-valid events with contiguous sequence numbers', async () => {
    const transport = setup();
    const { runId } = await transport.startRun(startRequest(['research']));
    const events = await collectEvents(transport, runId ?? '');
    expect(events.length).toBeGreaterThan(10);
    expect(events.map((e) => e.runSeq)).toEqual(events.map((_, i) => i + 1));
    for (const event of events) expect(RunEvent.safeParse(event).success).toBe(true);
  });

  it('[TC-OBS-002-H] replaying the event log rebuilds the same projection', async () => {
    const transport = setup();
    const { runId } = await transport.startRun(startRequest(['research', 'writer']));
    const events = await collectEvents(transport, runId ?? '');
    const { projection } = await transport.getSnapshot(runId ?? '');
    const replayed = events.reduce(applyEvent, emptyProjection(runId ?? ''));
    expect(projection.status).toBe('succeeded');
    expect(replayed).toEqual(projection);
  });

  it('[TC-RACE-07] a subscriber starting from a snapshot sees each later event once, in order', async () => {
    const gate = new Gate();
    const transport = setup({ gates: [gate] });
    const { runId } = await transport.startRun(startRequest(['research', 'writer']));
    const id = runId ?? '';
    await waitForProjection(transport, id, (p) => p.lastSeq > 0);
    const snapshot = await transport.getSnapshot(id);
    const seen: number[] = [];
    const unsubscribe = transport.subscribe(id, snapshot.seq, {
      onEvent: (event) => seen.push(event.runSeq),
    });
    gate.open();
    const final = await waitForProjection(transport, id, settled);
    await Promise.resolve();
    unsubscribe();
    expect(seen.length).toBeGreaterThan(0);
    const expected = Array.from(
      { length: final.lastSeq - snapshot.seq },
      (_, i) => snapshot.seq + i + 1,
    );
    expect(seen).toEqual(expected);
  });

  it('rejects a definition the runner cannot execute, without creating a run', async () => {
    const transport = setup();
    const request = startRequest(['research']);
    request.definition.entryNodeId = 'output';
    const { runId, receipt } = await transport.startRun(request);
    expect(runId).toBeNull();
    expect(receipt.status).toBe('rejected');
    expect(receipt.error?.code).toBe('GRAPH_INVALID');
  });

  it('[TC-DEV-001-H] starting a run twice with the same commandId returns the same run', async () => {
    const transport = setup();
    const first = await transport.startRun(startRequest(['research']));
    const again = await transport.startRun(startRequest(['research']));
    expect(first.runId).toMatch(/^run_/);
    expect(first.receipt.status).toBe('applied');
    expect(again.runId).toBe(first.runId);
    expect(again.receipt.acceptedSeq).toBe(first.receipt.acceptedSeq);
  });

  it('fails the execution and the run when the role may not write artifacts', async () => {
    const transport = setup();
    const request = startRequest(['research']);
    const role = request.definition.roles[0];
    if (role) role.allowedWorkTools = [];
    const { runId } = await transport.startRun(request);
    const events = await collectEvents(transport, runId ?? '');
    const final = await waitForProjection(transport, runId ?? '', settled);
    expect(final.status).toBe('failed');
    expect(events.some((e) => e.type === 'tool.blocked')).toBe(true);
    expect(events.some((e) => e.type === 'artifact.version_created')).toBe(false);
  });
});

describe('InMemoryCoordinator: steering', () => {
  async function runningWriter(turns: number, gates: Gate[]) {
    const transport = setup({ turns, gates });
    const { runId } = await transport.startRun(startRequest(['writer']));
    const id = runId ?? '';
    const projection = await waitForProjection(transport, id, (p) => {
      const exec = p.executions[executionOf(p, 'writer') ?? ''];
      return exec?.modelCallIds.length === 1;
    });
    return { transport, runId: id, executionId: executionOf(projection, 'writer') ?? '' };
  }

  it('[TC-RNS-001-N] [TC-RACE-01] a steer accepted during request 1 reaches request 2 only', async () => {
    const gates = [new Gate(), new Gate()];
    const { transport, runId, executionId } = await runningWriter(2, gates);

    const receipt = await transport.sendCommand(steer(runId, executionId));
    gates[0]?.open();
    gates[1]?.open();
    const final = await waitForProjection(transport, runId, settled);

    const [call1, call2] = final.executions[executionId]?.modelCallIds ?? [];
    const directiveId = final.directiveOrder[0] ?? '';
    expect(final.modelCalls[call1 ?? '']?.directiveIds).toEqual([]);
    expect(final.modelCalls[call2 ?? '']?.directiveIds).toEqual([directiveId]);
    expect(final.directives[directiveId]).toMatchObject({
      status: 'delivered',
      modelCallId: call2,
    });
    expect(receipt.acceptedSeq).not.toBeNull();

    const artifact = final.output?.artifactVersionIds[0] ?? '';
    expect(directDirectivesForArtifact(final, artifact)).toEqual([directiveId]);
  });

  it('[TC-RNS-002-N] the steer receipt reports queued, not applied, until delivery', async () => {
    const gates = [new Gate(), new Gate()];
    const { transport, runId, executionId } = await runningWriter(2, gates);

    const receipt = await transport.sendCommand(steer(runId, executionId));
    expect(receipt.status).toBe('queued');
    const snapshot = await transport.getSnapshot(runId);
    expect(Object.values(snapshot.projection.directives)[0]?.status).toBe('queued');

    gates[0]?.open();
    gates[1]?.open();
    await waitForProjection(transport, runId, settled);
    expect((await transport.getReceipt(runId, receipt.commandId))?.status).toBe('applied');
  });

  it('[TC-RACE-13] a steer whose target finishes before another request expires', async () => {
    const gates = [new Gate()];
    const { transport, runId, executionId } = await runningWriter(1, gates);

    const receipt = await transport.sendCommand(steer(runId, executionId));
    gates[0]?.open();
    const final = await waitForProjection(transport, runId, settled);

    expect(Object.values(final.directives)[0]?.status).toBe('expired');
    expect((await transport.getReceipt(runId, receipt.commandId))?.status).toBe('expired');
    const artifact = final.output?.artifactVersionIds[0] ?? '';
    expect(directDirectivesForArtifact(final, artifact)).toEqual([]);
  });

  it('[TC-DEV-001-N] reusing a commandId with another payload is a conflict with no effect', async () => {
    const gates = [new Gate(), new Gate()];
    const { transport, runId, executionId } = await runningWriter(2, gates);

    const first = await transport.sendCommand(steer(runId, executionId));
    const resent = await transport.sendCommand(steer(runId, executionId));
    const conflicting = steer(runId, executionId);
    conflicting.payload.text = 'Something else.';
    const conflict = await transport.sendCommand(conflicting);

    expect(resent.acceptedSeq).toBe(first.acceptedSeq);
    expect(conflict.status).toBe('rejected');
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    const { projection } = await transport.getSnapshot(runId);
    expect(Object.keys(projection.directives)).toHaveLength(1);
    for (const gate of gates) gate.open();
  });

  it('rejects a steer for an unknown or finished execution', async () => {
    const transport = setup();
    const { runId } = await transport.startRun(startRequest(['writer']));
    const final = await waitForProjection(transport, runId ?? '', settled);
    const finished = await transport.sendCommand(
      steer(runId ?? '', executionOf(final, 'writer') ?? ''),
    );
    const unknown = await transport.sendCommand(steer(runId ?? '', 'exec_9999', 'cmd_other'));
    expect(finished.error?.code).toBe('TARGET_TERMINAL');
    expect(unknown.error?.code).toBe('TARGET_NOT_FOUND');
  });
});
