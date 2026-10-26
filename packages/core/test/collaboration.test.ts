import type { AgentStartInput, CorralDefinition, RunEvent } from '@corral/contracts';
import {
  collaborationCorral,
  FakeClock,
  Gate,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

async function drain() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function runtime(
  options: Partial<ScriptedAgentOptions> = {},
  extra: { residentLimit?: number } = {},
) {
  const clock = new FakeClock();
  const started: AgentStartInput[] = [];
  const scripted = new ScriptedAgentAdapter({ turns: 1, ...options });
  const transport = new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      ...(extra.residentLimit
        ? { policy: { ...SPEC_HARD_CAPS, maxResidentExecutions: extra.residentLimit } }
        : {}),
      agents: {
        start: (input, host) => {
          started.push(input);
          return scripted.start(input, host);
        },
      },
    }),
  );
  return { transport, clock, started };
}

async function run(
  transport: InProcessTransport,
  definition: CorralDefinition = collaborationCorral(),
) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_collab',
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
  return { runId, events };
}

const byNode = (p: RunProjection, nodeId: string) =>
  (p.nodeExecutions[nodeId] ?? []).map((id) => p.executions[id]);

describe('delegation: spawn and await', () => {
  it('a parent runs two children at once and holds no model slot while it waits', async () => {
    const definition = collaborationCorral();
    definition.limits = { ...definition.limits, maxModelConcurrency: 1 };
    const { transport } = runtime();
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, settled);
    await drain();

    expect(final.status).toBe('succeeded');
    const [research] = byNode(final, 'research');
    const helpers = byNode(final, 'helper');
    expect(helpers).toHaveLength(2);
    for (const helper of helpers) {
      expect(helper?.parentExecutionId).toBe(research?.executionId);
      expect(helper?.depth).toBe(1);
      expect(helper?.status).toBe('succeeded');
    }
    // Both children were active before either finished: they ran in parallel.
    const firstHelperSettled = events.findIndex(
      (e) =>
        e.type === 'execution.settled' &&
        helpers.some((h) => h?.executionId === e.payload.executionId),
    );
    const activeBefore = events
      .slice(0, firstHelperSettled)
      .filter(
        (e) =>
          e.type === 'execution.state_changed' &&
          e.payload.to === 'active' &&
          helpers.some((h) => h?.executionId === e.payload.executionId),
      );
    expect(activeBefore).toHaveLength(2);
    // The parent waited for exactly its children, then resumed.
    const waiting = events.find(
      (e) => e.type === 'execution.state_changed' && e.payload.to === 'waiting_children',
    );
    expect(
      waiting?.type === 'execution.state_changed' &&
        [...(waiting.payload.waitingOn?.targetIds ?? [])].sort(),
    ).toEqual(helpers.map((h) => h?.executionId).sort());
  });

  it('never has more model requests open than the concurrency limit', async () => {
    const definition = collaborationCorral();
    definition.limits = { ...definition.limits, maxModelConcurrency: 1 };
    const { transport } = runtime({ turns: 2 });
    const { runId, events } = await run(transport, definition);
    await waitForProjection(transport, runId, settled);
    await drain();
    let open = 0;
    let most = 0;
    for (const event of events) {
      if (event.type === 'model.request_prepared') most = Math.max(most, ++open);
      if (event.type === 'model.finished') open -= 1;
    }
    expect(most).toBe(1);
  });

  it('refuses delegating to a node without a capability link, and records it', async () => {
    const definition = collaborationCorral();
    // The helper stays callable, but from the writer: the researcher has no link to it.
    definition.capabilityLinks = definition.capabilityLinks.map((l) =>
      l.kind === 'delegate' ? { ...l, sourceNodeId: 'write' } : l,
    );
    for (const role of definition.roles) {
      if (role.id === 'writer') role.allowedCollaborationTools.push('spawn_subagents');
    }
    const { transport } = runtime({
      script: async (input, host) => {
        if (input.nodeId !== 'research') return null;
        const spawn = await host.invokeTool({
          name: 'spawn_subagents',
          args: { tasks: [{ targetNodeId: 'helper', brief: 'part 1' }] },
        });
        return spawn.ok ? null : { outcome: 'failed', error: spawn.error.message };
      },
    });
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, settled);
    await drain();
    expect(final.status).toBe('failed');
    expect(byNode(final, 'helper')).toEqual([]);
    const blocked = events.find((e) => e.type === 'tool.blocked');
    expect(blocked?.type === 'tool.blocked' && blocked.payload.reason).toContain('helper');
  });

  it('refuses a spawn batch that does not fit, whole, and the parent does not wait forever', async () => {
    const { transport } = runtime({}, { residentLimit: 2 });
    const { runId, events } = await run(transport);
    const final = await waitForProjection(transport, runId, settled);
    await drain();
    // Research (1 live) + 2 helpers would exceed 2 resident executions: nothing is created.
    expect(byNode(final, 'helper')).toEqual([]);
    const blocked = events.find((e) => e.type === 'tool.blocked');
    expect(blocked?.type === 'tool.blocked' && blocked.payload.reason).toMatch(
      /^RESOURCE_CAPACITY/,
    );
    expect(final.status).toBe('failed');
    expect(Object.values(final.executions).some((e) => e.status.startsWith('waiting'))).toBe(false);
  });

  it('a failed child stays failed: its task is not reassigned', async () => {
    const { transport } = runtime({
      script: async (input) =>
        input.nodeId === 'helper' ? { outcome: 'failed', error: 'helper broke' } : null,
    });
    const { runId } = await run(transport);
    const final = await waitForProjection(transport, runId, settled);
    await drain();
    const helpers = byNode(final, 'helper');
    expect(helpers).toHaveLength(2);
    for (const helper of helpers) {
      const task = final.tasks[helper?.taskId ?? ''];
      expect(task?.status).toBe('failed');
      expect(task?.attemptCount).toBe(1);
    }
  });
});

describe('questions answered by new responder tasks', () => {
  it('the writer asks, a new responder task answers once, and the answer reaches the draft', async () => {
    const { transport, started } = runtime();
    const { runId, events } = await run(transport);
    const final = await waitForProjection(transport, runId, settled);
    await drain();

    expect(final.status).toBe('succeeded');
    const [write] = byNode(final, 'write');
    const [respond] = byNode(final, 'respond');
    expect(respond?.parentExecutionId).toBe(write?.executionId);
    expect(respond?.depth).toBe(1);
    const [question] = Object.values(final.questions);
    expect(question).toMatchObject({
      senderExecutionId: write?.executionId,
      targetNodeId: 'respond',
      status: 'answered',
      answer: { responderExecutionId: respond?.executionId },
    });
    expect(final.tasks[respond?.taskId ?? '']?.status).toBe('completed');
    expect(events.filter((e) => e.type === 'message.answer_committed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'message.closed')).toHaveLength(1);
    const responderInput = started.find((s) => s.nodeId === 'respond');
    expect(responderInput?.assignment).toMatchObject({
      kind: 'question',
      questionId: question?.questionId,
    });
    const draft = await transport.getArtifactText(runId, final.output?.artifactVersionIds[0] ?? '');
    expect(draft).toContain(question?.answer?.body ?? 'missing');
  });

  it('a timed-out question closes once, wakes the asker, and ignores a late reply', async () => {
    const responderGate = new Gate();
    // A slow responder that answers anyway once it gets going: its answer arrives too late.
    const { transport, clock } = runtime({
      script: async (input, host) => {
        if (input.assignment.kind !== 'question') return null;
        await responderGate.wait();
        await host.invokeTool({
          name: 'reply',
          args: { questionId: input.assignment.questionId, body: 'Too late.', evidenceRefs: [] },
        });
        return { outcome: 'succeeded' };
      },
    });
    const definition = collaborationCorral();
    const { runId, events } = await run(transport, definition);
    await waitForProjection(transport, runId, (p) =>
      Object.values(p.questions).some((q) => q.status === 'open'),
    );
    clock.advance(definition.limits.questionTimeoutMs);
    await drain();
    responderGate.open();
    const final = await waitForProjection(transport, runId, settled);
    await drain();

    const [question] = Object.values(final.questions);
    expect(question?.status).toBe('timed_out');
    expect(events.filter((e) => e.type === 'message.closed')).toHaveLength(1);
    expect(events.some((e) => e.type === 'message.answer_committed')).toBe(false);
    // The asker was told and moved on: it is not left waiting.
    const [write] = byNode(final, 'write');
    expect(write?.status).not.toBe('waiting_message');
    expect(final.tasks[byNode(final, 'respond')[0]?.taskId ?? '']?.status).toBe('cancelled');
    const late = events.find((e) => e.type === 'observation.late');
    expect(late?.type === 'observation.late' && late.payload.originalRef).toBe(
      question?.questionId,
    );
  });

  it('a responder counts toward the spawn limit like any child', async () => {
    const definition = collaborationCorral();
    definition.limits = { ...definition.limits, maxSpawns: 2 };
    const { transport } = runtime();
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, settled);
    await drain();
    // Two helpers used both spawns; the writer's question is refused, not created.
    expect(byNode(final, 'helper')).toHaveLength(2);
    expect(byNode(final, 'respond')).toEqual([]);
    const blocked = events.filter((e) => e.type === 'tool.blocked');
    expect(
      blocked.some(
        (e) => e.type === 'tool.blocked' && e.payload.reason.startsWith('LIMIT_REACHED'),
      ),
    ).toBe(true);
    const limit = events.find((e) => e.type === 'limit.reached');
    expect(limit?.type === 'limit.reached' && limit.payload).toMatchObject({
      limitKind: 'spawns',
      used: 2,
      max: 2,
    });
  });

  it('an earlier responder uses up spawns: a later delegation over the limit is refused', async () => {
    // Research asks first (one responder), then the writer delegates two helpers: 3 > 2.
    const definition = collaborationCorral();
    definition.limits = { ...definition.limits, maxSpawns: 2 };
    definition.capabilityLinks = [
      { id: 'cap1', kind: 'question', sourceNodeId: 'research', targetNodeId: 'respond' },
      { id: 'cap2', kind: 'delegate', sourceNodeId: 'write', targetNodeId: 'helper' },
    ];
    for (const role of definition.roles) {
      if (role.id === 'researcher')
        role.allowedCollaborationTools = ['ask', 'read_artifact', 'submit_result'];
      if (role.id === 'writer') {
        role.allowedCollaborationTools = [
          'spawn_subagents',
          'await_tasks',
          'read_artifact',
          'submit_result',
        ];
      }
    }
    const { transport } = runtime();
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, settled);
    await drain();
    expect(byNode(final, 'respond')).toHaveLength(1);
    expect(byNode(final, 'helper')).toEqual([]);
    const limit = events.find((e) => e.type === 'limit.reached');
    expect(limit?.type === 'limit.reached' && limit.payload).toMatchObject({
      limitKind: 'spawns',
      used: 1,
      max: 2,
    });
  });

  it('refuses a reply to a question this execution was not asked', async () => {
    const { transport } = runtime({
      script: async (input, host) => {
        if (input.nodeId !== 'write') return null;
        const reply = await host.invokeTool({
          name: 'reply',
          args: { questionId: 'q_unknown', body: 'Not mine to answer.', evidenceRefs: [] },
        });
        return reply.ok ? null : { outcome: 'failed', error: reply.error.message };
      },
    });
    const definition = collaborationCorral();
    for (const role of definition.roles)
      if (role.id === 'writer') role.allowedCollaborationTools.push('reply');
    const { runId, events } = await run(transport, definition);
    await waitForProjection(transport, runId, settled);
    await drain();
    expect(events.some((e) => e.type === 'message.answer_committed')).toBe(false);
    expect(events.some((e) => e.type === 'tool.blocked')).toBe(true);
  });
});

describe('artifacts across tasks', () => {
  it('two helpers write the same output name without overwriting each other', async () => {
    const { transport } = runtime();
    const { runId } = await run(transport);
    const final = await waitForProjection(transport, runId, settled);
    await drain();
    const helperArtifacts = Object.values(final.artifacts).filter((a) => a.name === 'notes-part');
    expect(helperArtifacts).toHaveLength(2);
    expect(new Set(helperArtifacts.map((a) => a.artifactId)).size).toBe(2);
    // Research read each child's submitted version, and the read is on record.
    const [research] = byNode(final, 'research');
    expect(final.artifactReads[research?.executionId ?? '']?.sort()).toEqual(
      helperArtifacts.map((a) => a.artifactVersionId).sort(),
    );
  });

  it('only submitted versions move on; a draft that was never submitted does not', async () => {
    const { transport } = runtime({
      script: async (input, host) => {
        if (input.nodeId !== 'write') return null;
        const draft = await host.invokeTool({
          name: 'write_artifact',
          args: { text: 'unsubmitted draft' },
        });
        const final = await host.invokeTool({
          name: 'write_artifact',
          args: { text: 'submitted draft' },
        });
        if (!draft.ok || !final.ok) return { outcome: 'failed', error: 'write failed' };
        await host.invokeTool({
          name: 'submit_result',
          args: { artifactVersionIds: [final.result.artifactVersionId] },
        });
        return { outcome: 'succeeded' };
      },
    });
    const { runId } = await run(transport);
    const final = await waitForProjection(transport, runId, settled);
    expect(final.output?.artifactVersionIds).toHaveLength(1);
    expect(await transport.getArtifactText(runId, final.output?.artifactVersionIds[0] ?? '')).toBe(
      'submitted draft',
    );
  });
});
