import { describe, expect, it } from 'vitest';
import { resolveIntent } from './composerIntent.ts';

// UX-01: what a request is (and for which execution) is fixed when the person starts typing;
// it never changes by itself when the run moves on.

const base = {
  allowed: ['steer', 'queue'] as const,
  chosen: null,
  chosenTarget: null,
  lock: null,
  targets: ['exec_research', 'exec_writer'],
  running: true,
};

describe('composer intent (UX-01)', () => {
  it('follows the run while the box is empty', () => {
    expect(resolveIntent({ ...base, allowed: ['steer', 'queue'] })).toEqual({
      intent: 'steer',
      target: 'exec_research',
      blocked: null,
    });
    expect(resolveIntent({ ...base, allowed: ['queue'], targets: [] })).toEqual({
      intent: 'queue',
      target: null,
      blocked: null,
    });
  });

  it('keeps the locked execution when it is still running', () => {
    expect(resolveIntent({ ...base, lock: { intent: 'steer', target: 'exec_writer' } })).toEqual({
      intent: 'steer',
      target: 'exec_writer',
      blocked: null,
    });
  });

  it('never hands a locked instruction to another execution', () => {
    expect(
      resolveIntent({
        ...base,
        targets: ['exec_writer'],
        lock: { intent: 'steer', target: 'exec_research' },
      }),
    ).toEqual({ intent: 'steer', target: 'exec_research', blocked: 'target' });
  });

  it('never turns a locked instruction into a queued task when a decision waits', () => {
    expect(
      resolveIntent({
        ...base,
        allowed: ['queue'],
        targets: [],
        lock: { intent: 'steer', target: 'exec_research' },
      }),
    ).toEqual({ intent: 'steer', target: 'exec_research', blocked: 'target' });
  });

  it('blocks a locked instruction once the run has ended', () => {
    expect(
      resolveIntent({
        ...base,
        allowed: ['next', 'explain'],
        targets: [],
        running: false,
        lock: { intent: 'steer', target: 'exec_research' },
      }),
    ).toEqual({ intent: 'steer', target: 'exec_research', blocked: 'run' });
  });

  it('blocks a locked follow-up while another run works, instead of queueing it', () => {
    expect(
      resolveIntent({
        ...base,
        allowed: ['queue'],
        lock: { intent: 'next', target: null },
      }),
    ).toEqual({ intent: 'next', target: null, blocked: 'intent' });
  });

  it('honours an explicit choice that is possible now', () => {
    expect(resolveIntent({ ...base, chosen: 'queue' })).toEqual({
      intent: 'queue',
      target: null,
      blocked: null,
    });
    expect(resolveIntent({ ...base, chosenTarget: 'exec_writer' })).toEqual({
      intent: 'steer',
      target: 'exec_writer',
      blocked: null,
    });
  });
});
