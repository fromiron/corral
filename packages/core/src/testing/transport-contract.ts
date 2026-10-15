import type { AgentAdapter, RunCommand, RunEvent, StartRunRequest } from '@corral/contracts';
import { Gate, linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import type { RunProjection } from '../projection.ts';
import { type RuntimeTransport, waitForProjection } from '../transport.ts';

/**
 * Behaviour every RuntimeTransport must share (C-053, ADR-016). In-process today;
 * HttpSseTransport (C-015) runs the same suite against the local server.
 */
export function describeTransportContract(
  name: string,
  makeTransport: (agents: AgentAdapter) => RuntimeTransport,
) {
  const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

  function steeredRun() {
    const gates = [new Gate(), new Gate()];
    let reply = 0;
    const transport = makeTransport(
      new ScriptedAgentAdapter({
        turns: 2,
        beforeReply: () => gates[reply++]?.wait() ?? Promise.resolve(),
      }),
    );
    return { transport, gates };
  }

  const start: StartRunRequest = {
    schemaVersion: '0.1',
    commandId: 'cmd_contract_start',
    definition: linearCorral(['writer'], 'contract'),
    mode: 'mock',
  };

  const steerCommand = (runId: string, targetExecutionId: string): RunCommand => ({
    schemaVersion: '0.1',
    commandId: 'cmd_contract_steer',
    runId,
    type: 'steer',
    payload: { targetExecutionId, text: 'Primary sources only.', delivery: 'next_request' },
  });

  async function firstRequestInFlight(transport: RuntimeTransport) {
    const { runId } = await transport.startRun(start);
    if (!runId) throw new Error('run was not created');
    const projection = await waitForProjection(transport, runId, (p) =>
      Object.values(p.executions).some((e) => e.modelCallIds.length === 1),
    );
    const executionId = projection.executionOrder[0] ?? '';
    return { runId, executionId };
  }

  describe(`RuntimeTransport contract: ${name}`, () => {
    it('commits the reference event order for a run steered during its first request', async () => {
      const { transport, gates } = steeredRun();
      const { runId, executionId } = await firstRequestInFlight(transport);
      const events: RunEvent[] = [];
      const unsubscribe = transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });

      const receipt = await transport.sendCommand(steerCommand(runId, executionId));
      for (const gate of gates) gate.open();
      await waitForProjection(transport, runId, settled);
      await Promise.resolve();
      unsubscribe();

      expect(receipt).toMatchObject({ status: 'queued', requestedBoundary: 'next_request' });
      expect(events.map((e) => e.type)).toEqual([
        'run.started',
        'run.state_changed',
        'run.state_changed',
        'task.created',
        'execution.created',
        'task.attempt_assigned',
        'execution.state_changed',
        'model.request_prepared',
        'directive.accepted',
        'model.finished',
        'directive.attached',
        'model.request_prepared',
        'directive.dispatched',
        'model.finished',
        'tool.requested',
        'artifact.version_created',
        'tool.requested',
        'task.submitted',
        'task.completed',
        'execution.settled',
        'output.finalized',
        'run.state_changed',
      ]);
      expect(events.map((e) => e.runSeq)).toEqual(events.map((_, i) => i + 1));
      expect((await transport.getReceipt(runId, receipt.commandId))?.status).toBe('applied');
    });

    it('[TC-RACE-08] a resent command returns the same receipt without a second effect', async () => {
      const { transport, gates } = steeredRun();
      const { runId, executionId } = await firstRequestInFlight(transport);
      const first = await transport.sendCommand(steerCommand(runId, executionId));
      const resent = await transport.sendCommand(steerCommand(runId, executionId));
      const changed = steerCommand(runId, executionId);
      changed.payload.text = 'Different text.';
      const conflict = await transport.sendCommand(changed);
      const { projection } = await transport.getSnapshot(runId);
      for (const gate of gates) gate.open();

      expect(resent).toEqual(first);
      expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(projection.directiveOrder).toHaveLength(1);
    });

    it('[TC-OBS-002-N] snapshot plus subscription neither drops nor repeats events', async () => {
      const { transport, gates } = steeredRun();
      const { runId } = await firstRequestInFlight(transport);
      const snapshot = await transport.getSnapshot(runId);
      const seen: number[] = [];
      const unsubscribe = transport.subscribe(runId, snapshot.seq, {
        onEvent: (e) => seen.push(e.runSeq),
      });
      for (const gate of gates) gate.open();
      const final = await waitForProjection(transport, runId, settled);
      await Promise.resolve();
      unsubscribe();

      expect(seen[0]).toBe(snapshot.seq + 1);
      expect(seen).toEqual(
        Array.from({ length: final.lastSeq - snapshot.seq }, (_, i) => snapshot.seq + i + 1),
      );
    });
  });
}
