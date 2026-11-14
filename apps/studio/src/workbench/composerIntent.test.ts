import { emptyProjection, type RunProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { intentOf, resolveIntent, type SteerTarget, targetsOf } from './composerIntent.ts';

// features/composer-flow.md "전송" and "합류 대상": what each key sends in each situation, and
// which execution an instruction goes to.

const writer: SteerTarget = {
  id: 'exec_writer',
  label: 'Writer',
  interruptible: true,
  awaiting: false,
};
const research: SteerTarget = {
  id: 'exec_research',
  label: 'Research',
  interruptible: true,
  awaiting: false,
};

const base = {
  running: true,
  targets: [writer, research],
  lead: 'exec_writer',
  chosenTarget: null,
  lock: null,
  chosen: null,
};

describe('send keys by situation', () => {
  it('sends a new request with every key while nothing runs', () => {
    expect(resolveIntent({ ...base, running: false, targets: [], lead: null })).toEqual({
      situation: 'idle',
      target: null,
      blocked: null,
      keys: { send: 'new', interrupt: 'new', queue: 'new' },
      base: { send: 'new', interrupt: 'new', queue: 'new' },
    });
  });

  it('joins with the send key while a run goes and the target can take an instruction', () => {
    expect(resolveIntent(base)).toEqual({
      situation: 'join',
      target: 'exec_writer',
      blocked: null,
      keys: { send: 'join', interrupt: 'interrupt', queue: 'queue' },
      base: { send: 'join', interrupt: 'interrupt', queue: 'queue' },
    });
  });

  it('joins with the interrupt key too when the target cannot be interrupted', () => {
    const quiet = { ...writer, interruptible: false };
    expect(resolveIntent({ ...base, targets: [quiet] })).toEqual({
      situation: 'joinOnly',
      target: 'exec_writer',
      blocked: null,
      keys: { send: 'join', interrupt: 'join', queue: 'queue' },
      base: { send: 'join', interrupt: 'join', queue: 'queue' },
    });
  });

  it('queues with every key while a run goes and nothing can take an instruction', () => {
    expect(resolveIntent({ ...base, targets: [], lead: null })).toEqual({
      situation: 'noTarget',
      target: null,
      blocked: null,
      keys: { send: 'queue', interrupt: 'queue', queue: 'queue' },
      base: { send: 'queue', interrupt: 'queue', queue: 'queue' },
    });
  });

  it('joins, read after the decision, while the target waits on the person', () => {
    const waiting = { ...writer, interruptible: false, awaiting: true };
    expect(resolveIntent({ ...base, targets: [waiting] })).toEqual({
      situation: 'awaiting',
      target: 'exec_writer',
      blocked: null,
      keys: { send: 'join', interrupt: 'join', queue: 'queue' },
      base: { send: 'join', interrupt: 'join', queue: 'queue' },
    });
  });

  it('never offers an interrupt to a target that waits on the person', () => {
    // Even if the execution were said to be interruptible, a waiting one has no response to cut.
    const waiting = { ...writer, awaiting: true };
    expect(resolveIntent({ ...base, targets: [waiting] }).keys.interrupt).toBe('join');
  });

  it('a new request sent while another run goes waits behind it', () => {
    expect(intentOf('new', false)).toEqual({ intent: 'next', delivery: null });
    expect(intentOf('new', true)).toEqual({ intent: 'queue', delivery: null });
    expect(intentOf('queue', true)).toEqual({ intent: 'queue', delivery: null });
    expect(intentOf('join', true)).toEqual({ intent: 'steer', delivery: 'next_request' });
    expect(intentOf('interrupt', true)).toEqual({ intent: 'steer', delivery: 'interrupt' });
  });
});

describe('counterexamples', () => {
  it('a run that just ended sends a new request, never an instruction to its stale targets', () => {
    const ended = resolveIntent({ ...base, running: false });
    expect(ended.situation).toBe('idle');
    expect(ended.target).toBeNull();
    expect(ended.keys.send).toBe('new');
  });

  it('a run going with no target never joins', () => {
    const none = resolveIntent({ ...base, targets: [] });
    expect(none.keys.send).toBe('queue');
    expect(none.target).toBeNull();
  });

  it('the default during a run is not the next request', () => {
    expect(resolveIntent(base).keys.send).not.toBe('queue');
  });
});

describe('the target', () => {
  it('is the execution writing the conversation answer unless another one is chosen', () => {
    expect(resolveIntent(base).target).toBe('exec_writer');
    expect(resolveIntent({ ...base, chosenTarget: 'exec_research' }).target).toBe('exec_research');
  });

  it('falls back to the first open execution when the lead takes no instruction', () => {
    expect(resolveIntent({ ...base, lead: 'exec_gone' }).target).toBe('exec_writer');
    expect(resolveIntent({ ...base, targets: [research] }).target).toBe('exec_research');
  });

  it('an unfixed choice that ended falls back to the lead', () => {
    expect(resolveIntent({ ...base, chosenTarget: 'exec_gone' }).target).toBe('exec_writer');
  });

  it('a fixed target stays while it can take the instruction', () => {
    const fixed = resolveIntent({
      ...base,
      chosenTarget: 'exec_writer',
      lock: { intent: 'steer', target: 'exec_research' },
    });
    expect(fixed.target).toBe('exec_research');
    expect(fixed.blocked).toBeNull();
    expect(fixed.keys.send).toBe('join');
  });

  it('a fixed target that ended blocks; it never moves to another execution or the queue', () => {
    const blocked = resolveIntent({
      ...base,
      targets: [writer],
      lock: { intent: 'steer', target: 'exec_research' },
    });
    expect(blocked).toEqual({
      situation: 'blocked',
      target: 'exec_research',
      blocked: 'target',
      keys: { send: 'join', interrupt: 'join', queue: 'queue' },
      base: { send: 'join', interrupt: 'join', queue: 'queue' },
    });
  });

  it('a fixed target whose run ended blocks; it never becomes a new request by itself', () => {
    const blocked = resolveIntent({
      ...base,
      running: false,
      targets: [],
      lock: { intent: 'steer', target: 'exec_writer' },
    });
    expect(blocked.blocked).toBe('run');
    expect(blocked.target).toBe('exec_writer');
    expect(blocked.keys.send).toBe('join');
    expect(blocked.keys.queue).toBe('new');
  });

  it('a draft not fixed on a target follows the run: joins when one starts, new when it ends', () => {
    const idle = { ...base, running: false, targets: [], lead: null };
    expect(resolveIntent(idle).keys.send).toBe('new');
    expect(resolveIntent({ ...idle, running: true, targets: [writer] })).toEqual(
      expect.objectContaining({
        target: 'exec_writer',
        keys: expect.objectContaining({ send: 'join' }),
      }),
    );
  });

  it('a stored lock that is not an instruction fixes nothing', () => {
    for (const intent of ['queue', 'next', 'explain'] as const) {
      expect(resolveIntent({ ...base, lock: { intent, target: null } }).keys.send).toBe('join');
      expect(
        resolveIntent({
          ...base,
          running: false,
          targets: [],
          lock: { intent, target: null },
        }).keys.send,
      ).toBe('new');
    }
  });
});

describe('a send chosen once (/next, /steer, /interrupt or the send menu)', () => {
  it('makes the send key do it', () => {
    expect(resolveIntent({ ...base, chosen: 'interrupt' }).keys.send).toBe('interrupt');
    expect(resolveIntent({ ...base, chosen: 'queue' }).keys.send).toBe('queue');
    expect(resolveIntent({ ...base, chosen: 'join' }).keys.send).toBe('join');
  });

  it('follows the situation: an interrupt joins where it cannot cut, a queue starts when idle', () => {
    const quiet = { ...writer, interruptible: false };
    expect(resolveIntent({ ...base, targets: [quiet], chosen: 'interrupt' }).keys.send).toBe(
      'join',
    );
    expect(
      resolveIntent({
        ...base,
        running: false,
        targets: [],
        lead: null,
        chosen: 'queue',
      }).keys.send,
    ).toBe('new');
    expect(resolveIntent({ ...base, targets: [], chosen: 'join' }).keys.send).toBe('queue');
  });

  it('leaves what the keys send without it, which the send menu follows', () => {
    expect(resolveIntent({ ...base, chosen: 'queue' }).base).toEqual({
      send: 'join',
      interrupt: 'interrupt',
      queue: 'queue',
    });
  });

  it('with a fixed target whose run ended, a next request is a new request', () => {
    const blocked = resolveIntent({
      ...base,
      running: false,
      targets: [],
      lock: { intent: 'steer', target: 'exec_writer' },
      chosen: 'queue',
    });
    expect(blocked.keys.send).toBe('new');
    expect(blocked.base.queue).toBe('new');
  });
});

function projection(): RunProjection {
  const value = emptyProjection('run_live');
  value.status = 'running';
  value.executionOrder = ['exec_writer', 'exec_review', 'exec_check', 'exec_done', 'exec_second'];
  const execution = (id: string, nodeId: string, status: string, waitingOn = null as unknown) =>
    ({
      executionId: id,
      nodeId,
      taskId: `task_${id}`,
      attemptNo: 1,
      status,
      activity: null,
      waitingOn,
      modelCallIds: [],
      error: null,
    }) as never;
  value.executions = {
    exec_writer: execution('exec_writer', 'writer', 'active'),
    exec_review: execution('exec_review', 'review', 'waiting_approval'),
    exec_check: execution('exec_check', 'check', 'active'),
    exec_done: execution('exec_done', 'writer', 'succeeded'),
    exec_second: execution('exec_second', 'writer', 'waiting_children'),
  };
  return value;
}

function definition() {
  const corral = linearCorral(['writer', 'review']);
  return {
    ...corral,
    nodes: [
      ...corral.nodes.map((node) =>
        node.id === 'writer'
          ? { ...node, label: 'Writer' }
          : node.id === 'review'
            ? { ...node, label: 'Review' }
            : node,
      ),
      {
        id: 'check',
        label: 'Checks',
        type: 'decision' as const,
        mode: 'check' as const,
        checkIds: ['lint'],
        inputBindings: [],
      },
    ],
  };
}

describe('targets read from the run projection', () => {
  it('lists the open executions that can take an instruction, and which of them can be cut', () => {
    expect(targetsOf(projection(), definition() as never)).toEqual({
      lead: 'exec_writer',
      targets: [
        { id: 'exec_writer', label: 'Writer · #1', interruptible: true, awaiting: false },
        { id: 'exec_review', label: 'Review', interruptible: false, awaiting: true },
        // A check step calls no model: it takes no instruction.
        { id: 'exec_second', label: 'Writer · #5', interruptible: false, awaiting: false },
      ],
    });
  });

  it('a question to the person makes its execution wait on the person', () => {
    const value = projection();
    value.executions.exec_writer = {
      ...value.executions.exec_writer,
      status: 'waiting_message',
      waitingOn: {
        kind: 'user',
        targetIds: [],
        reasonCode: 'ask_user',
        since: '2026-11-13T00:00:00Z',
        deadline: null,
        required: true,
      },
    } as never;
    expect(targetsOf(value, definition() as never).targets[0]).toEqual(
      expect.objectContaining({ id: 'exec_writer', interruptible: false, awaiting: true }),
    );
  });

  it('a run that is stopping, or ended, takes no instruction', () => {
    for (const status of ['cancelling', 'succeeded', 'cancelled'] as const) {
      const value = projection();
      value.status = status;
      expect(targetsOf(value, definition() as never).targets).toEqual([]);
    }
  });

  it('an execution that is stopping takes no instruction', () => {
    const value = projection();
    value.executions.exec_writer = {
      ...value.executions.exec_writer,
      status: 'cancelling',
    } as never;
    expect(targetsOf(value, definition() as never).targets.map((item) => item.id)).toEqual([
      'exec_review',
      'exec_second',
    ]);
  });

  it('names an execution by its node id while the definition is not read yet', () => {
    expect(targetsOf(projection(), null).targets[0]?.label).toBe('writer · #1');
  });

  it('an advisor takes no instruction: it is no join target (features/advisor.md)', () => {
    const value = projection();
    value.executionOrder = [...value.executionOrder, 'exec_advisor'];
    value.executions.exec_advisor = {
      ...value.executions.exec_writer,
      executionId: 'exec_advisor',
      nodeId: 'writer',
      taskId: 'task_advisor',
      status: 'waiting_message',
      advisor: true,
    } as never;
    const targets = targetsOf(value, definition() as never).targets;
    expect(targets.map((item) => item.id)).not.toContain('exec_advisor');
    // Nor does it make another of a role's name need its place to be told apart.
    expect(targets.map((item) => item.label)).toEqual(['Writer · #1', 'Review', 'Writer · #5']);
  });
});
