import type { RunEvent } from '@corral/contracts';
import { FakeClock } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  applyProgressEvent,
  createsWaitCycle,
  emptyProgress,
  LogicalDeadline,
  noProgressReached,
} from '../src/limits.ts';
import {
  type ExecutionView,
  emptyProjection,
  type QuestionView,
  type TaskView,
} from '../src/projection.ts';

const event = (type: string, payload: unknown): RunEvent => ({ type, payload }) as RunEvent;
const waiting = (id: string, kind: 'children' | 'message', targetIds: string[]): ExecutionView =>
  ({
    executionId: id,
    taskId: `task_${id}`,
    status: kind === 'message' ? 'waiting_message' : 'waiting_children',
    waitingOn: {
      kind,
      targetIds,
      reasonCode: 'test',
      since: '2026-10-15T00:00:00Z',
      deadline: null,
      required: true,
    },
  }) as ExecutionView;

describe('waits and finite run limits', () => {
  it('new file ranges and changed results count as progress, repeated evidence does not', () => {
    const p = emptyProjection('run');
    let progress = { ...emptyProgress(), turns: 6 };
    progress = applyProgressEvent(
      progress,
      event('tool.finished', { error: null, progressHash: 'a'.repeat(64) }),
      p,
    );
    expect(progress.turns).toBe(0);
    progress = { ...progress, turns: 6 };
    expect(
      applyProgressEvent(
        progress,
        event('tool.finished', { error: null, progressHash: 'a'.repeat(64) }),
        p,
      ).turns,
    ).toBe(6);
    expect(
      applyProgressEvent(
        progress,
        event('tool.finished', { error: null, progressHash: 'b'.repeat(64) }),
        p,
      ).turns,
    ).toBe(0);
    expect(
      applyProgressEvent(
        progress,
        event('tool.finished', { error: 'failed', progressHash: 'c'.repeat(64) }),
        p,
      ).turns,
    ).toBe(6);
  });
  it('an addressed parent answer advances collaboration; unrelated messages and timeouts do not', () => {
    const p = emptyProjection('run');
    p.questions.child_question = {
      questionId: 'child_question',
      delivery: 'parent',
      targetExecutionId: 'parent',
    } as QuestionView;
    const stalled = { ...emptyProgress(), turns: 6 };
    expect(
      applyProgressEvent(
        stalled,
        event('message.answer_committed', {
          questionId: 'child_question',
          responderExecutionId: 'parent',
          body: 'Use A',
        }),
        p,
      ).turns,
    ).toBe(0);
    expect(
      applyProgressEvent(
        stalled,
        event('message.answer_committed', {
          questionId: 'child_question',
          responderExecutionId: 'other',
          body: 'Use A',
        }),
        p,
      ).turns,
    ).toBe(6);
    expect(
      applyProgressEvent(
        stalled,
        event('message.closed', {
          questionId: 'child_question',
          outcome: 'timed_out',
        }),
        p,
      ).turns,
    ).toBe(6);
  });
  it('wait cycles resolve question IDs to responder executions', () => {
    const p = emptyProjection('run');
    p.executions = { a: waiting('a', 'message', ['question']), b: waiting('b', 'children', ['c']) };
    p.questions.question = {
      questionId: 'question',
      taskId: 'task_b',
      status: 'open',
    } as QuestionView;
    p.tasks.task_b = { activeExecutionId: 'b' } as TaskView;
    expect(createsWaitCycle(p, 'c', ['a'])).toBe(true);
    expect(createsWaitCycle(p, 'c', ['c'])).toBe(true);
    expect(createsWaitCycle(p, 'd', ['a'])).toBe(false);
    p.questions.question.status = 'cancelled';
    expect(createsWaitCycle(p, 'c', ['a'])).toBe(false);
  });

  it('question logical timeout stops during pause while a wall timer continues', () => {
    const clock = new FakeClock();
    let logicalExpired = 0;
    let wallExpired = 0;
    const timer = new LogicalDeadline(clock, clock, 1_000, () => logicalExpired++);
    clock.after(2_000, () => wallExpired++);
    clock.advance(400);
    timer.pause();
    expect(timer.remainingMs).toBe(600);
    clock.advance(3_000);
    expect(logicalExpired).toBe(0);
    expect(wallExpired).toBe(1);
    timer.resume();
    timer.resume();
    clock.advance(599);
    expect(logicalExpired).toBe(0);
    clock.advance(1);
    expect(logicalExpired).toBe(1);
    timer.resume();
    clock.advance(5_000);
    expect(logicalExpired).toBe(1);
  });

  it('cancelled logical deadlines never fire or resume', () => {
    const clock = new FakeClock();
    let expired = false;
    const timer = new LogicalDeadline(clock, clock, 1_000, () => {
      expired = true;
    });
    timer.cancel();
    timer.resume();
    clock.advance(2_000);
    expect(expired).toBe(false);
  });

  it('six message-only turns require user input and real submitted progress resets them', () => {
    const p = emptyProjection('run');
    let progress = emptyProgress();
    for (let i = 0; i < 6; i++) {
      const finished = event('model.finished', { modelCallId: `call_${i}` });
      progress = applyProgressEvent(progress, finished, p);
      progress = applyProgressEvent(progress, finished, p);
      progress = applyProgressEvent(
        progress,
        event('message.answer_committed', { body: 'message only' }),
        p,
      );
    }
    expect(progress.turns).toBe(6);
    expect(noProgressReached(progress)).toBe(true);
    p.artifacts.art = { contentHash: 'new-content' } as NonNullable<typeof p.artifacts.art>;
    progress = applyProgressEvent(
      progress,
      event('task.submitted', { artifactVersionIds: ['art'] }),
      p,
    );
    expect(progress.turns).toBe(0);
    progress = applyProgressEvent(
      progress,
      event('model.finished', { modelCallId: 'next_call' }),
      p,
    );
    progress = applyProgressEvent(
      progress,
      event('task.submitted', { artifactVersionIds: ['art'] }),
      p,
    );
    expect(progress.turns).toBe(1);
    progress = applyProgressEvent(progress, event('approval.resolved', {}), p);
    expect(progress.turns).toBe(0);
  });

  it('rewording the same unmet review criterion does not claim progress', () => {
    const p = emptyProjection('run');
    const review = (reason: string) =>
      event('review.recorded', {
        criteriaVersionId: 'criteria_1',
        verdict: 'revise',
        issues: [{ criterionId: 'sources', severity: 'required', reason, evidenceRefs: [] }],
      });
    let progress = applyProgressEvent(emptyProgress(), review('Missing source'), p);
    progress = applyProgressEvent(progress, event('model.finished', { modelCallId: 'call' }), p);
    progress = applyProgressEvent(progress, review('Need a source'), p);
    expect(progress.turns).toBe(1);
    progress = applyProgressEvent(
      progress,
      event('review.recorded', { criteriaVersionId: 'criteria_1', verdict: 'pass', issues: [] }),
      p,
    );
    expect(progress.turns).toBe(0);
  });
});
