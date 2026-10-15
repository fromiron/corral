import type { Receipt, RunEvent, SteerCommand } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

// C-012 model-based check. Random interleavings of steering commands (new, resent,
// conflicting, aimed at a finished execution) and agent progress. The seed is fixed so a
// failure reproduces exactly; fast-check prints the shrunk counterexample.
const SEED = 20261015;

type Action =
  | { kind: 'steer'; slot: number; text: 'a' | 'b'; target: 'current' | 'first' }
  | { kind: 'advance' };

const action: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    kind: fc.constant('steer' as const),
    slot: fc.integer({ min: 0, max: 3 }),
    text: fc.constantFrom('a' as const, 'b' as const),
    target: fc.constantFrom('current' as const, 'first' as const),
  }),
  fc.constant({ kind: 'advance' as const }),
);

async function drain() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('Coordinator model-based property (C-012)', () => {
  it('[TC-DEV-001-H] [TC-RACE-08] resends, conflicts and late steers never break the run log', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 25 }), async (actions) => {
        const gates = Array.from({ length: 8 }, () => new Gate());
        let reply = 0;
        const transport = new InProcessTransport(
          new Coordinator({
            clock: new FakeClock(),
            ids: new SequentialIdFactory(),
            agents: new ScriptedAgentAdapter({
              turns: 2,
              beforeReply: () => gates[reply++]?.wait() ?? Promise.resolve(),
            }),
          }),
        );
        const events: RunEvent[] = [];
        const { runId } = await transport.startRun({
          schemaVersion: '0.1',
          commandId: 'cmd_start',
          definition: linearCorral(['research', 'writer']),
          mode: 'mock',
        });
        const id = runId ?? '';
        transport.subscribe(id, 0, { onEvent: (e) => events.push(e) });

        // Model: what each commandId was first sent with, and the receipt it got.
        const sent = new Map<string, { text: string; target: string; receipt: Receipt }>();
        let opened = 0;
        for (const step of actions) {
          await drain();
          const { projection } = await transport.getSnapshot(id);
          if (step.kind === 'advance') {
            gates[opened++]?.open();
            continue;
          }
          const executions = projection.executionOrder;
          const target =
            (step.target === 'first' ? executions[0] : executions.at(-1)) ?? 'exec_missing';
          const commandId = `cmd_${step.slot}`;
          const command: SteerCommand = {
            schemaVersion: '0.1',
            commandId,
            runId: id,
            type: 'steer',
            payload: { targetExecutionId: target, text: step.text, delivery: 'next_request' },
          };
          const before = projection.lastSeq;
          const receipt = await transport.sendCommand(command);
          const first = sent.get(commandId);
          if (!first) {
            sent.set(commandId, { text: step.text, target, receipt });
          } else if (first.text !== step.text || first.target !== target) {
            // Same id, other payload: a conflict, and nothing is committed.
            expect(receipt.error?.code).toBe('IDEMPOTENCY_CONFLICT');
            expect((await transport.getSnapshot(id)).projection.lastSeq).toBe(before);
          } else {
            // Acceptance is stable; delivery adds status and causal event references.
            expect({ ...receipt, status: null, relatedEventIds: [] }).toEqual({
              ...first.receipt,
              status: null,
              relatedEventIds: [],
            });
            expect(receipt.relatedEventIds.slice(0, first.receipt.relatedEventIds.length)).toEqual(
              first.receipt.relatedEventIds,
            );
            expect(new Set(receipt.relatedEventIds).size).toBe(receipt.relatedEventIds.length);
            expect((await transport.getSnapshot(id)).projection.lastSeq).toBe(before);
          }
        }
        for (const gate of gates) gate.open();
        const final: RunProjection = await waitForProjection(transport, id, (p) =>
          ['succeeded', 'failed'].includes(p.status),
        );
        await drain();

        // The log is contiguous and rebuilds the same projection.
        expect(events.map((e) => e.runSeq)).toEqual(events.map((_, i) => i + 1));
        expect(events.reduce(applyEvent, emptyProjection(id))).toEqual(final);
        // One directive per accepted commandId, delivered at most once, never backwards.
        const accepted = [...sent.values()].filter((s) => !s.receipt.error);
        expect(final.directiveOrder).toHaveLength(accepted.length);
        for (const directiveId of final.directiveOrder) {
          const directive = final.directives[directiveId];
          if (directive?.status !== 'delivered') continue;
          const call = final.modelCalls[directive.modelCallId ?? ''];
          const prepared = events.find(
            (e) =>
              e.type === 'model.request_prepared' &&
              e.payload.modelCallId === directive.modelCallId,
          );
          expect(call?.executionId).toBe(directive.targetExecutionId);
          expect(prepared?.runSeq ?? 0).toBeGreaterThan(directive.acceptedSeq);
        }
        // No effect is admitted after the run ended.
        const end = events.findIndex(
          (e) => e.type === 'run.state_changed' && e.payload.to === final.status,
        );
        expect(events.slice(end + 1).some((e) => e.type === 'effect.admitted')).toBe(false);
      }),
      { seed: SEED, numRuns: 60 },
    );
  });
});
