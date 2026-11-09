import type { AgentHost } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

function setup() {
  const store = new InMemoryRunStore();
  const hosts: AgentHost[] = [];
  const inner = new ScriptedAgentAdapter({
    turns: 1,
    appendNotes: false,
    script: async (input, host) => {
      if (input.inputs.some((part) => part.text === 'FAIL'))
        return { outcome: 'failed', error: 'fixture failure' };
      // A draft the step writes but does not submit.
      if (input.nodeId === 'writer' && input.inputs.some((part) => part.text === 'DRAFT'))
        await host.invokeTool({ name: 'write_artifact', args: { text: 'unsubmitted draft' } });
      return null;
    },
  });
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: {
      start: (input, host) => {
        hosts.push(host);
        return inner.start(input, host);
      },
    },
  });
  const transport = new InProcessTransport(coordinator);
  return { store, coordinator, transport, hosts };
}
/** The last completed submission of a node. */
function submitted(p: Awaited<ReturnType<typeof finish>>['p'], nodeId: string) {
  for (const id of [...(p.nodeExecutions[nodeId] ?? [])].reverse()) {
    const task = p.tasks[p.executions[id]?.taskId ?? ''];
    if (task?.status === 'completed') return task.submittedArtifactVersionIds;
  }
  return [];
}
async function finish(s: ReturnType<typeof setup>, commandId: string, brief: string) {
  const definition = linearCorral(['writer', 'editor']);
  definition.input.brief = brief;
  const result = s.coordinator.startRun({
    schemaVersion: '0.1',
    commandId,
    definition,
    mode: 'mock',
    sessionId: 'session_retention',
  });
  expect(result.runId).toBeTruthy();
  const p = await waitForProjection(s.transport, result.runId!, (p) => p.status === 'succeeded');
  return { runId: result.runId!, p };
}
describe('artifact body lifetime', () => {
  it('releases intermediate bodies after settlement while retaining provenance, step results and the final result', async () => {
    const s = setup();
    const { runId, p } = await finish(s, 'cmd_first', 'DRAFT');
    const final = p.output!.artifactVersionIds[0]!;
    const step = submitted(p, 'writer')[0]!;
    const old = Object.keys(p.artifacts).filter((id) => id !== final && id !== step);
    expect(old.length).toBeGreaterThan(0);
    for (const id of old) expect(s.store.getArtifactText(runId, id)).toBeNull();
    expect(s.store.getArtifactText(runId, final)).toBeTruthy();
    expect(s.store.getArtifactText(runId, step)).toBeTruthy();
    expect(s.coordinator.getArtifactText(runId, step)).toBeTruthy();
    expect(s.store.readEvents(runId, 0).some((e) => e.type === 'artifact.content_released')).toBe(
      true,
    );
    expect(Object.keys(s.coordinator.getSnapshot(runId).projection.artifacts)).toEqual(
      Object.keys(p.artifacts),
    );
  });
  it('keeps active operational bodies until cancellation and every execution settle', async () => {
    const store = new InMemoryRunStore();
    const entered = new Gate();
    const finish = new Gate();
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: {
        async start() {
          entered.open();
          return {
            cancel: async () => {},
            waitForSettlement: async () => {
              await finish.wait();
              return { outcome: 'cancelled' as const };
            },
          };
        },
      },
    });
    const transport = new InProcessTransport(coordinator);
    const { runId } = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_active',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    await entered.wait();
    store.putArtifactText(runId!, 'operational', 'needed by current execution');
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cmd_cancel',
      runId: runId!,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    expect(store.getArtifactText(runId!, 'operational')).toBe('needed by current execution');
    expect(coordinator.getSnapshot(runId!).projection.status).toBe('cancelling');
    finish.open();
    await waitForProjection(transport, runId!, (p) => p.status === 'cancelled');
    expect(store.getArtifactText(runId!, 'operational')).toBeNull();
    expect(() => store.putArtifactText(runId!, 'operational', 'late')).toThrow();
  });
  it('a failed newer run does not discard the previous successful result or its step results', async () => {
    const s = setup();
    const first = await finish(s, 'cmd_first', 'first');
    const id = first.p.output!.artifactVersionIds[0]!;
    const step = submitted(first.p, 'writer')[0]!;
    const original = s.store.getArtifactText(first.runId, id);
    const definition = linearCorral(['writer']);
    definition.input.brief = 'FAIL';
    const failed = s.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_failed',
      definition,
      mode: 'mock',
      sessionId: 'session_retention',
    });
    await waitForProjection(s.transport, failed.runId!, (p) => p.status === 'failed');
    expect(s.store.getArtifactText(first.runId, id)).toBe(original);
    expect(s.store.getArtifactText(first.runId, step)).toBeTruthy();
    expect(s.coordinator.getConversationTurn(failed.runId!)?.answer).toBeNull();
  });
  it('accepts late usage after another run released the old final without closing admission', async () => {
    const s = setup();
    const first = await finish(s, 'cmd_first', 'first');
    const host = s.hosts[0]!;
    const call = Object.values(first.p.modelCalls)[0]!;
    await finish(s, 'cmd_second', 'second');
    await host.observe({
      kind: 'model_completed',
      modelCallId: call.modelCallId,
      text: 'late text',
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const third = await finish(s, 'cmd_third', 'third');
    expect(third.p.status).toBe('succeeded');
    expect(s.store.getArtifactText(first.runId, first.p.output!.artifactVersionIds[0]!)).toBeNull();
  });
  it('supersedes old final bodies without losing primary conversation turns', async () => {
    const s = setup();
    const first = await finish(s, 'cmd_first', 'first');
    const final = first.p.output!.artifactVersionIds[0]!;
    const step = submitted(first.p, 'writer')[0]!;
    const answer = s.store.getArtifactText(first.runId, final);
    await finish(s, 'cmd_second', 'second');
    expect(s.store.getArtifactText(first.runId, final)).toBeNull();
    expect(s.store.getArtifactText(first.runId, step)).toBeNull();
    expect(s.coordinator.getArtifactText(first.runId, step)).toBeNull();
    expect(s.coordinator.getConversationTurn(first.runId)?.answer).toBe(answer);
    expect(() => s.store.putArtifactText(first.runId, final, 'resurrected')).toThrow();
  });
});
