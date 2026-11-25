import type { AgentHost, AgentStartInput, DeliveredDirective } from '@corral/contracts';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import {
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

// docs/specs/llm-runtime.md: six replies without progress leave a warning and the run goes on;
// the same tool with the same arguments three times in a row gets one note from Corral.

const ended = (p: RunProjection) =>
  ['succeeded', 'failed', 'cancelled', 'awaiting_user'].includes(p.status);

function run(
  agents: ScriptedAgentAdapter,
  store = new InMemoryRunStore(),
): Promise<{ projection: RunProjection; store: InMemoryRunStore; runId: string }> {
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents,
  });
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  const runId = started.runId ?? '';
  return waitForProjection(new InProcessTransport(coordinator), runId, ended).then(
    (projection) => ({ projection, store, runId }),
  );
}

it('six replies without progress warn once and never pause the run', async () => {
  const { projection, store, runId } = await run(new ScriptedAgentAdapter({ turns: 9 }));
  expect(projection.status).toBe('succeeded');
  expect(Object.keys(projection.modelCalls)).toHaveLength(9);
  expect(Object.values(projection.approvals)).toHaveLength(0);
  const events = store.readEvents(runId, 0);
  expect(
    events.filter((e) => e.type === 'extension.ui_notified' && e.payload.key === 'no_progress'),
  ).toHaveLength(1);
  expect(events.some((e) => e.type === 'limit.reached')).toBe(false);
});

/** An agent that asks for one model request, then calls each proposal in turn, recording notes. */
function caller(
  calls: { name: string; args: Record<string, unknown> }[],
  seen: DeliveredDirective[][],
) {
  return new ScriptedAgentAdapter({
    turns: 1,
    collaborate: false,
    appendNotes: false,
    script: async (input: AgentStartInput, host: AgentHost) => {
      for (const call of calls) {
        const permit = await host.prepareModelRequest();
        seen.push(permit.directives);
        await host.observe({
          kind: 'model_completed',
          modelCallId: permit.modelCallId,
          text: `calling ${call.name}`,
          usage: { inputTokens: null, outputTokens: 1 },
        });
        await host.invokeTool(call);
      }
      const permit = await host.prepareModelRequest();
      seen.push(permit.directives);
      await host.observe({
        kind: 'model_completed',
        modelCallId: permit.modelCallId,
        text: 'done',
        usage: { inputTokens: null, outputTokens: 1 },
      });
      void input;
      return { outcome: 'failed', error: 'scripted end' };
    },
  });
}

const read = (artifactVersionId: string) => ({
  name: 'read_artifact',
  args: { artifactVersionId },
});

it('the third identical call in a row gets one Corral note on the next request', async () => {
  const seen: DeliveredDirective[][] = [];
  const { projection, store, runId } = await run(
    caller([read('artv_a'), read('artv_a'), read('artv_a'), read('artv_a'), read('artv_a')], seen),
  );
  const notes = store
    .readEvents(runId, 0)
    .filter((e) => e.type === 'directive.accepted' && e.payload.origin === 'corral');
  expect(notes).toHaveLength(1);
  expect(notes[0]?.payload).toMatchObject({ delivery: 'next_request' });
  expect(String((notes[0]?.payload as { text?: string } | undefined)?.text)).toContain(
    'read_artifact',
  );
  // Delivered with the request after the third call, once.
  expect(seen.map((list) => list.filter((d) => d.origin === 'corral').length)).toEqual([
    0, 0, 0, 1, 0, 0,
  ]);
  expect(projection.status).toBe('failed');
});

it('a call with other arguments breaks the run of calls, and await_tasks neither counts nor breaks it', async () => {
  const seen: DeliveredDirective[][] = [];
  const { store, runId } = await run(
    caller(
      [
        read('artv_a'),
        read('artv_a'),
        read('artv_b'),
        read('artv_a'),
        read('artv_a'),
        { name: 'await_tasks', args: { taskIds: ['task_x'] } },
        { name: 'await_tasks', args: { taskIds: ['task_x'] } },
        { name: 'await_tasks', args: { taskIds: ['task_x'] } },
      ],
      seen,
    ),
  );
  const notes = store
    .readEvents(runId, 0)
    .filter((e) => e.type === 'directive.accepted' && e.payload.origin === 'corral');
  expect(notes).toHaveLength(0);
});

it('a call between waits still counts as in a row', async () => {
  const seen: DeliveredDirective[][] = [];
  const { store, runId } = await run(
    caller(
      [
        read('artv_a'),
        { name: 'await_tasks', args: { taskIds: ['task_x'] } },
        read('artv_a'),
        { name: 'await_tasks', args: { taskIds: ['task_x'] } },
        read('artv_a'),
      ],
      seen,
    ),
  );
  const notes = store
    .readEvents(runId, 0)
    .filter((e) => e.type === 'directive.accepted' && e.payload.origin === 'corral');
  expect(notes).toHaveLength(1);
});
