import type {
  AgentHost,
  AgentSettlement,
  AgentStartInput,
  ParentQuestionMessage,
  ToolOutcome,
} from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { Coordinator, InProcessTransport, waitForProjection } from '../src/index.ts';

function definition() {
  const value = linearCorral(['parent']);
  value.roles[0]!.allowedCollaborationTools.push(
    'spawn_subagents',
    'await_tasks',
    'reply',
    'read_artifact',
  );
  value.roles.push({
    ...value.roles[0]!,
    id: 'child_role',
    name: 'Child',
    allowedCollaborationTools: ['ask', 'submit_result'],
  });
  value.nodes.push({
    id: 'child',
    type: 'agent',
    label: 'Child',
    roleId: 'child_role',
    invocation: 'callable',
    inputBindings: [],
    outputName: 'text',
  });
  value.capabilityLinks.push({
    id: 'delegate_child',
    kind: 'delegate',
    sourceNodeId: 'parent',
    targetNodeId: 'child',
    parentQuestions: true,
  });
  value.limits = { ...value.limits, maxModelConcurrency: 1, maxSpawns: 2 };
  return value;
}

async function finish(host: AgentHost, text: string) {
  const written = await host.invokeTool({ name: 'write_artifact', args: { text } });
  if (!written.ok) throw new Error(written.error.message);
  const submitted = await host.invokeTool({
    name: 'submit_result',
    args: { artifactVersionIds: [written.result.artifactVersionId] },
  });
  if (!submitted.ok) throw new Error(submitted.error.message);
  return { outcome: 'succeeded' as const };
}

function questions(result: ToolOutcome) {
  if (!result.ok) throw new Error(result.error.message);
  return (result.result.parentQuestions ?? []) as ParentQuestionMessage[];
}

async function setup(
  script: (input: AgentStartInput, host: AgentHost) => Promise<AgentSettlement>,
  maxSpawns = 2,
) {
  const clock = new FakeClock();
  const started: AgentStartInput[] = [];
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      script: (input, host) => {
        started.push(input);
        return script(input, host);
      },
    }),
  });
  const transport = new InProcessTransport(coordinator);
  const planned = definition();
  planned.limits.maxSpawns = maxSpawns;
  const begun = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'parent_question_start',
    mode: 'mock',
    definition: planned,
  });
  if (!begun.runId) throw new Error(JSON.stringify(begun.receipt.error));
  return { clock, started, coordinator, transport, runId: begun.runId };
}

describe('existing parent questions (ABS-11)', () => {
  it.each([2, 3])(
    'restart preserves the remaining item reservation at maxSpawns=%s',
    async (maxSpawns) => {
      const interrupted = new Gate();
      const resumeParent = new Gate();
      const state = await setup(async (input, host) => {
        if (input.nodeId === 'child') {
          const answer = await host.invokeTool({
            name: 'ask',
            args: {
              targetNodeId: 'parent',
              body: `item ${input.item?.index}, attempt ${input.attemptNo}`,
            },
          });
          if (!answer.ok || answer.result.outcome !== 'answered') return { outcome: 'cancelled' };
          return finish(host, `finished item ${input.item?.index}`);
        }
        const batch = await host.invokeTool({
          name: 'spawn_subagents',
          args: {
            mode: 'items',
            tasks: [
              { targetNodeId: 'child', brief: 'first item' },
              { targetNodeId: 'child', brief: 'reserved second item' },
            ],
          },
        });
        if (!batch.ok) throw new Error(batch.error.message);
        expect(questions(batch)).toHaveLength(1);
        expect(batch.result.remaining).toBe(1);
        interrupted.open();
        await resumeParent.wait();
        if (maxSpawns === 2) return { outcome: 'cancelled' };
        for (;;) {
          const awaited = await host.invokeTool({
            name: 'await_tasks',
            args: { taskIds: batch.result.taskIds },
          });
          if (!awaited.ok) throw new Error(awaited.error.message);
          const pending = questions(awaited);
          if (!pending.length) break;
          for (const question of pending)
            await host.invokeTool({
              name: 'reply',
              args: { questionId: question.questionId, body: 'Continue' },
            });
        }
        return finish(host, 'both items completed after retry');
      }, maxSpawns);
      await interrupted.wait();
      const child = state.started.find((input) => input.nodeId === 'child')!;
      await state.transport.sendCommand({
        schemaVersion: '0.1',
        runId: state.runId,
        commandId: 'cancel_reserved_item',
        type: 'cancel',
        payload: {
          scope: { kind: 'execution', executionId: child.executionId },
          reason: 'retry item',
        },
      });
      const blocked = await waitForProjection(
        state.transport,
        state.runId,
        (p) => p.tasks[child.taskId]?.status === 'blocked',
      );
      const receipt = await state.transport.sendCommand({
        schemaVersion: '0.1',
        runId: state.runId,
        commandId: 'restart_reserved_item',
        expectedControlRevision: blocked.controlRevision,
        type: 'restart_task',
        payload: {
          taskId: child.taskId,
          previousExecutionId: child.executionId,
          instruction: 'retry',
        },
      });
      if (maxSpawns === 2) {
        await state.transport.sendCommand({
          schemaVersion: '0.1',
          runId: state.runId,
          commandId: 'stop_reserved_batch',
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'no capacity for a retry' },
        });
        resumeParent.open();
        await waitForProjection(state.transport, state.runId, (p) => p.status === 'cancelled');
        expect(receipt.status).toBe('rejected');
        expect(receipt.error?.code).toBe('LIMIT_REACHED');
        expect(state.started.filter((input) => input.nodeId === 'child')).toHaveLength(1);
      } else {
        resumeParent.open();
        expect(receipt.status).toBe('applied');
        const final = await waitForProjection(state.transport, state.runId, (p) =>
          ['succeeded', 'failed'].includes(p.status),
        );
        expect(final.status, JSON.stringify(final.executions)).toBe('succeeded');
        expect(
          state.started
            .filter((input) => input.nodeId === 'child')
            .map((input) => [input.item?.index, input.attemptNo]),
        ).toEqual([
          [1, 1],
          [1, 2],
          [2, 1],
        ]);
      }
    },
  );
  it('active parent receives both scoped questions and reads referenced child drafts', async () => {
    const resumeParent = new Gate();
    const observed: ParentQuestionMessage[] = [];
    const state = await setup(async (input, host) => {
      if (input.nodeId === 'child') {
        const other = await host.invokeTool({
          name: 'ask',
          args: { targetNodeId: 'child', body: 'Not my parent' },
        });
        expect(other.ok).toBe(false);
        const draft = await host.invokeTool({
          name: 'write_artifact',
          args: { text: `private draft ${input.executionId}` },
        });
        if (!draft.ok) throw new Error(draft.error.message);
        const answer = await host.invokeTool({
          name: 'ask',
          args: {
            targetNodeId: 'parent',
            body: 'Review this draft',
            artifactRefs: [draft.result.artifactVersionId],
          },
        });
        if (!answer.ok || answer.result.outcome !== 'answered') throw new Error('no answer');
        return finish(host, `used answer ${answer.result.body}`);
      }
      const spawned = await host.invokeTool({
        name: 'spawn_subagents',
        args: {
          tasks: [
            { targetNodeId: 'child', brief: 'first' },
            { targetNodeId: 'child', brief: 'second' },
          ],
        },
      });
      if (!spawned.ok) throw new Error(spawned.error.message);
      await resumeParent.wait();
      const permit = await host.prepareModelRequest();
      observed.push(...(permit.parentQuestions ?? []));
      await host.observe({
        kind: 'model_completed',
        modelCallId: permit.modelCallId,
        text: 'I will answer both children.',
        usage: { inputTokens: 10, outputTokens: 10 },
      });
      const protectedState = JSON.parse(host.protectedContext!().text);
      expect(protectedState.questions).toHaveLength(2);
      for (const question of observed) {
        const read = await host.invokeTool({
          name: 'read_artifact',
          args: { artifactVersionId: question.artifactRefs[0] },
        });
        expect(read.ok).toBe(true);
        const reply = await host.invokeTool({
          name: 'reply',
          args: {
            questionId: question.questionId,
            body: 'Reviewed',
            evidenceRefs: question.artifactRefs,
          },
        });
        expect(reply.ok).toBe(true);
      }
      await host.invokeTool({ name: 'await_tasks', args: { taskIds: spawned.result.taskIds } });
      return finish(host, 'both answered');
    });
    await waitForProjection(
      state.transport,
      state.runId,
      (p) => Object.values(p.questions).filter((q) => q.status === 'open').length === 2,
    );
    resumeParent.open();
    const final = await waitForProjection(state.transport, state.runId, (p) =>
      ['succeeded', 'failed'].includes(p.status),
    );
    expect(final.status, JSON.stringify(final.executions)).toBe('succeeded');
    expect(observed).toHaveLength(2);
    expect(new Set(observed.map((q) => q.senderExecutionId)).size).toBe(2);
    expect(Object.values(final.questions).every((q) => q.status === 'answered')).toBe(true);
  });

  it('run cancellation closes every question and leaves no waiting execution', async () => {
    const releaseParent = new Gate();
    const state = await setup(async (input, host) => {
      if (input.nodeId === 'child') {
        await host.invokeTool({ name: 'ask', args: { targetNodeId: 'parent', body: 'Pending' } });
        return { outcome: 'cancelled' };
      }
      await host.invokeTool({
        name: 'spawn_subagents',
        args: {
          tasks: [
            { targetNodeId: 'child', brief: 'first' },
            { targetNodeId: 'child', brief: 'second' },
          ],
        },
      });
      await releaseParent.wait();
      return { outcome: 'cancelled' };
    });
    await waitForProjection(
      state.transport,
      state.runId,
      (p) => Object.keys(p.questions).length === 2,
    );
    const receipt = await state.transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel_parent_questions',
      runId: state.runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop all' },
    });
    releaseParent.open();
    expect(receipt.status).toBe('accepted');
    const final = await waitForProjection(
      state.transport,
      state.runId,
      (p) => p.status === 'cancelled',
    );
    expect(Object.values(final.questions).every((q) => q.status === 'cancelled')).toBe(true);
    expect(Object.values(final.executions).every((e) => e.status === 'cancelled')).toBe(true);
  });
  it('restarts a child after its question interrupted the parent wait', async () => {
    const interrupted = new Gate();
    const resumeParent = new Gate();
    let originalQuestion = '';
    let staleReply: ToolOutcome | undefined;
    const state = await setup(async (input, host) => {
      if (input.nodeId === 'child') {
        const answer = await host.invokeTool({
          name: 'ask',
          args: { targetNodeId: 'parent', body: `attempt ${input.attemptNo}` },
        });
        if (!answer.ok || answer.result.outcome !== 'answered') return { outcome: 'cancelled' };
        return finish(host, `completed attempt ${input.attemptNo}`);
      }
      const spawned = await host.invokeTool({
        name: 'spawn_subagents',
        args: { tasks: [{ targetNodeId: 'child', brief: 'work' }] },
      });
      if (!spawned.ok) throw new Error(spawned.error.message);
      const first = await host.invokeTool({
        name: 'await_tasks',
        args: { taskIds: spawned.result.taskIds },
      });
      originalQuestion = questions(first)[0]!.questionId;
      interrupted.open();
      await resumeParent.wait();
      staleReply = await host.invokeTool({
        name: 'reply',
        args: { questionId: originalQuestion, body: 'Old answer' },
      });
      const next = await host.invokeTool({
        name: 'await_tasks',
        args: { taskIds: spawned.result.taskIds },
      });
      for (const question of questions(next))
        await host.invokeTool({
          name: 'reply',
          args: { questionId: question.questionId, body: 'New answer' },
        });
      await host.invokeTool({ name: 'await_tasks', args: { taskIds: spawned.result.taskIds } });
      return finish(host, 'parent remained the same');
    });
    await interrupted.wait();
    const child = state.started.find((s) => s.nodeId === 'child')!;
    await state.transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel_child',
      runId: state.runId,
      type: 'cancel',
      payload: {
        scope: { kind: 'execution', executionId: child.executionId },
        reason: 'try again',
      },
    });
    const blocked = await waitForProjection(
      state.transport,
      state.runId,
      (p) => p.tasks[child.taskId]?.status === 'blocked',
    );
    const restarted = await state.transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'restart_child',
      runId: state.runId,
      expectedControlRevision: blocked.controlRevision,
      type: 'restart_task',
      payload: {
        taskId: child.taskId,
        previousExecutionId: child.executionId,
        instruction: 'try again',
      },
    });
    resumeParent.open();
    expect(restarted.error).toBeUndefined();
    expect(restarted.status).toBe('applied');
    const final = await waitForProjection(state.transport, state.runId, (p) =>
      ['succeeded', 'failed'].includes(p.status),
    );
    expect(final.status, JSON.stringify(final.executions)).toBe('succeeded');
    expect(staleReply?.ok).toBe(false);
    expect(final.questions[originalQuestion]?.status).toBe('cancelled');
    expect(state.started.filter((s) => s.nodeId === 'parent')).toHaveLength(1);
    expect(state.started.filter((s) => s.nodeId === 'child').map((s) => s.attemptNo)).toEqual([
      1, 2,
    ]);
  });

  it('a child ending with a pending question closes it before draining tools', async () => {
    const crash = new Gate();
    const state = await setup(async (input, host) => {
      if (input.nodeId === 'child') {
        void host.invokeTool({
          name: 'ask',
          args: { targetNodeId: 'parent', body: 'Before crash' },
        });
        await crash.wait();
        return { outcome: 'failed', error: 'worker exited' };
      }
      const spawned = await host.invokeTool({
        name: 'spawn_subagents',
        args: { tasks: [{ targetNodeId: 'child', brief: 'work' }] },
      });
      if (!spawned.ok) throw new Error(spawned.error.message);
      const pending = await host.invokeTool({
        name: 'await_tasks',
        args: { taskIds: spawned.result.taskIds },
      });
      expect(questions(pending)).toHaveLength(1);
      crash.open();
      // Let the worker settle before checking its task again.
      for (let i = 0; i < 30; i++) await Promise.resolve();
      const ended = await host.invokeTool({
        name: 'await_tasks',
        args: { taskIds: spawned.result.taskIds },
      });
      if (!ended.ok) throw new Error(ended.error.message);
      expect((ended.result.tasks as { status: string }[])[0]?.status).toBe('failed');
      return finish(host, 'reported the child failure');
    });
    const final = await waitForProjection(state.transport, state.runId, (p) =>
      ['succeeded', 'failed'].includes(p.status),
    );
    expect(Object.values(final.questions)[0]?.status).toBe('cancelled');
    expect(state.clock.nowIso()).toBe('2026-10-15T00:00:00.000Z');
  });
  it.each([false, true])('same parent replies and continues, items=%s', async (items) => {
    const answers: unknown[] = [];
    const parentReplies: ToolOutcome[] = [];
    const state = await setup(async (input, host) => {
      if (input.nodeId === 'child') {
        const answer = await host.invokeTool({
          name: 'ask',
          args: { targetNodeId: 'parent', body: `Which option for ${input.item?.index ?? 1}?` },
        });
        if (!answer.ok) throw new Error(answer.error.message);
        answers.push(answer.result);
        return finish(host, `child received ${answer.result.body}`);
      }
      let result = await host.invokeTool({
        name: 'spawn_subagents',
        args: {
          ...(items ? { mode: 'items' } : {}),
          tasks: Array.from({ length: items ? 2 : 1 }, (_, i) => ({
            targetNodeId: 'child',
            brief: `item ${i + 1}`,
          })),
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      const taskIds = result.result.taskIds;
      if (items) {
        const stealsCapacity = await host.invokeTool({
          name: 'spawn_subagents',
          args: { tasks: [{ targetNodeId: 'child', brief: 'extra' }] },
        });
        expect(stealsCapacity.ok).toBe(false);
        const draft = await host.invokeTool({
          name: 'write_artifact',
          args: { text: 'premature parent result' },
        });
        if (!draft.ok) throw new Error(draft.error.message);
        const premature = await host.invokeTool({
          name: 'submit_result',
          args: { artifactVersionIds: [draft.result.artifactVersionId] },
        });
        expect(premature.ok).toBe(false);
      }
      for (let i = 0; i < 5; i++) {
        for (const question of questions(result)) {
          parentReplies.push(
            await host.invokeTool({
              name: 'reply',
              args: { questionId: question.questionId, body: 'Use A.' },
            }),
          );
          const duplicate = await host.invokeTool({
            name: 'reply',
            args: { questionId: question.questionId, body: 'Duplicate' },
          });
          expect(duplicate.ok).toBe(false);
        }
        result = await host.invokeTool({ name: 'await_tasks', args: { taskIds } });
        if (!result.ok) throw new Error(result.error.message);
        if (
          !questions(result).length &&
          result.result.remaining !== undefined &&
          result.result.remaining !== 0
        )
          continue;
        if (
          !questions(result).length &&
          (result.result.tasks as { status: string }[]).every((t) => t.status === 'completed')
        )
          break;
      }
      return finish(host, 'parent completed after answering');
    });
    const final = await waitForProjection(state.transport, state.runId, (p) =>
      ['succeeded', 'failed'].includes(p.status),
    );
    expect(final.status, JSON.stringify(final.executions)).toBe('succeeded');
    expect(answers).toHaveLength(items ? 2 : 1);
    expect(answers.every((a) => (a as { outcome: string }).outcome === 'answered')).toBe(true);
    expect(parentReplies.every((reply) => reply.ok && reply.result.terminal === false)).toBe(true);
    expect(state.started.filter((s) => s.nodeId === 'parent')).toHaveLength(1);
    expect(state.started).toHaveLength(items ? 3 : 2);
    expect(
      Object.values(final.questions).every(
        (q) => q.delivery === 'parent' && q.status === 'answered',
      ),
    ).toBe(true);
  });

  it('closes the child question without cancelling the parent; late reply is rejected', async () => {
    const parentReady = new Gate();
    const releaseParent = new Gate();
    let questionId = '';
    let late: ToolOutcome | undefined;
    let childResult: Record<string, unknown> | undefined;
    const state = await setup(async (input, host) => {
      if (input.nodeId === 'child') {
        const result = await host.invokeTool({
          name: 'ask',
          args: { targetNodeId: 'parent', body: 'Need input' },
        });
        if (!result.ok) throw new Error(result.error.message);
        childResult = result.result;
        return finish(host, 'continued after timeout');
      }
      const spawned = await host.invokeTool({
        name: 'spawn_subagents',
        args: { tasks: [{ targetNodeId: 'child', brief: 'work' }] },
      });
      if (!spawned.ok) throw new Error(spawned.error.message);
      const awaiting = await host.invokeTool({
        name: 'await_tasks',
        args: { taskIds: spawned.result.taskIds },
      });
      questionId = questions(awaiting)[0]?.questionId ?? '';
      parentReady.open();
      await releaseParent.wait();
      late = await host.invokeTool({ name: 'reply', args: { questionId, body: 'Too late' } });
      await host.invokeTool({ name: 'await_tasks', args: { taskIds: spawned.result.taskIds } });
      return finish(host, 'parent stayed alive');
    });
    await parentReady.wait();
    expect(questionId).not.toBe('');
    state.clock.advance(definition().limits.questionTimeoutMs);
    releaseParent.open();
    const final = await waitForProjection(state.transport, state.runId, (p) =>
      ['succeeded', 'failed'].includes(p.status),
    );
    expect(final.status).toBe('succeeded');
    expect(childResult?.outcome).toBe('timed_out');
    expect(late?.ok).toBe(false);
    expect(final.questions[questionId]?.status).toBe('timed_out');
  });
});
