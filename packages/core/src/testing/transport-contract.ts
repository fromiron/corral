import type {
  AgentAdapter,
  CorralDefinition,
  CreateRunRequest,
  RunEvent,
  StartRunRequest,
  SteerCommand,
} from '@corral/contracts';
import { Gate, linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import type { RunProjection } from '../projection.ts';
import { type RuntimeTransport, waitForProjection } from '../transport.ts';

export interface TransportHarness {
  transport: RuntimeTransport;
  /** The start request this runtime accepts; the server starts runs from saved revisions. */
  startRequest?(
    definition: CorralDefinition,
    commandId: string,
  ): Promise<StartRunRequest | CreateRunRequest>;
}

/**
 * Behaviour every RuntimeTransport must share (C-053, ADR-016): the in-process runtime and
 * HttpSseTransport against the local server (C-015) run the same cases.
 */
export function describeTransportContract(
  name: string,
  make: (agents: AgentAdapter) => RuntimeTransport | TransportHarness | Promise<TransportHarness>,
) {
  const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

  async function harness(agents: AgentAdapter): Promise<Required<TransportHarness>> {
    const made = await make(agents);
    const h: TransportHarness = 'transport' in made ? made : { transport: made };
    return {
      transport: h.transport,
      startRequest:
        h.startRequest ??
        (async (definition, commandId) => ({
          schemaVersion: '0.1',
          commandId,
          definition,
          mode: 'mock',
        })),
    };
  }

  async function steeredRun() {
    const gates = [new Gate(), new Gate()];
    let reply = 0;
    const h = await harness(
      new ScriptedAgentAdapter({
        turns: 2,
        beforeReply: () => gates[reply++]?.wait() ?? Promise.resolve(),
      }),
    );
    const start = await h.startRequest(linearCorral(['writer'], 'contract'), 'cmd_contract_start');
    return { transport: h.transport, gates, start };
  }

  const steerCommand = (runId: string, targetExecutionId: string): SteerCommand => ({
    schemaVersion: '0.1',
    commandId: 'cmd_contract_steer',
    runId,
    type: 'steer',
    payload: { targetExecutionId, text: 'Primary sources only.', delivery: 'next_request' },
  });

  async function firstRequestInFlight(
    transport: RuntimeTransport,
    start: StartRunRequest | CreateRunRequest,
  ) {
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
      const { transport, gates, start } = await steeredRun();
      const { runId, executionId } = await firstRequestInFlight(transport, start);
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
        'effect.admitted',
        'execution.state_changed',
        'model.request_prepared',
        'effect.admitted',
        'directive.accepted',
        'model.finished',
        'effect.settled',
        'directive.attached',
        'model.request_prepared',
        'effect.admitted',
        'directive.dispatched',
        'model.finished',
        'effect.settled',
        'tool.requested',
        'tool.allowed',
        'effect.admitted',
        'tool.started',
        'artifact.version_created',
        'tool.finished',
        'effect.settled',
        'tool.requested',
        'tool.allowed',
        'effect.admitted',
        'tool.started',
        'task.submitted',
        'task.completed',
        'tool.finished',
        'effect.settled',
        'execution.settled',
        'effect.settled',
        'output.finalized',
        'run.state_changed',
      ]);
      expect(events.map((e) => e.runSeq)).toEqual(events.map((_, i) => i + 1));
      expect((await transport.getReceipt(runId, receipt.commandId))?.status).toBe('applied');
    });

    it('lists the run and returns the definition it was started with', async () => {
      const { transport, gates, start } = await steeredRun();
      const { runId } = await firstRequestInFlight(transport, start);
      for (const gate of gates) gate.open();
      await waitForProjection(transport, runId, settled);
      expect((await transport.listRuns()).map((r) => [r.runId, r.status])).toEqual([
        [runId, 'succeeded'],
      ]);
      const definition = await transport.getRunDefinition(runId);
      expect(definition?.roles.map((r) => r.prompt)).toEqual(['Act as writer.']);
      expect(await transport.getRunDefinition('run_missing')).toBeNull();
    });

    it('[TC-RACE-08] a resent command returns the same receipt without a second effect', async () => {
      const { transport, gates, start } = await steeredRun();
      const { runId, executionId } = await firstRequestInFlight(transport, start);
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
      const { transport, gates, start } = await steeredRun();
      const { runId } = await firstRequestInFlight(transport, start);
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
