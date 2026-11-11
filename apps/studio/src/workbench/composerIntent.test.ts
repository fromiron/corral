import { describe, expect, it } from 'vitest';
import { resolveIntent } from './composerIntent.ts';

// workbench.md: a next request is decided when it is sent (it starts a run, or waits behind the
// one that is going); only an instruction is fixed once the person starts typing.

const base = {
  allowed: ['next', 'steer'] as const,
  chosen: null,
  chosenTarget: null,
  lock: null,
  targets: ['exec_research', 'exec_writer'],
  running: true,
  waiting: true,
};

describe('composer intent', () => {
  it('keeps an empty composer on the next request until an instruction is explicitly chosen', () => {
    expect(resolveIntent(base)).toEqual({ intent: 'queue', target: null, blocked: null });
    expect(resolveIntent({ ...base, chosenTarget: 'exec_writer' })).toEqual({
      intent: 'queue',
      target: null,
      blocked: null,
    });
    expect(resolveIntent({ ...base, allowed: ['next'], targets: [] })).toEqual({
      intent: 'queue',
      target: null,
      blocked: null,
    });
  });

  it('sends a next request typed during a run as a new run once the run has ended', () => {
    // Nothing about the request was fixed while the run was going: no lock, no block.
    expect(
      resolveIntent({
        ...base,
        allowed: ['next'],
        targets: [],
        running: false,
        waiting: false,
      }),
    ).toEqual({ intent: 'next', target: null, blocked: null });
  });

  it('sends a next request typed while idle behind the run that started meanwhile', () => {
    const idle = {
      ...base,
      allowed: ['next'] as const,
      targets: [],
      running: false,
      waiting: false,
    };
    expect(resolveIntent(idle).intent).toBe('next');
    expect(resolveIntent({ ...idle, running: true, waiting: true })).toEqual({
      intent: 'queue',
      target: null,
      blocked: null,
    });
  });

  it('does not treat a stored queue, follow-up or question intent as fixed', () => {
    for (const intent of ['queue', 'next', 'explain'] as const) {
      expect(resolveIntent({ ...base, lock: { intent, target: null } }).intent).toBe('queue');
      expect(
        resolveIntent({
          ...base,
          lock: { intent, target: null },
          allowed: ['next'],
          running: false,
          waiting: false,
        }),
      ).toEqual({ intent: 'next', target: null, blocked: null });
    }
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

  it('never turns a locked instruction into a next request when a decision waits', () => {
    expect(
      resolveIntent({
        ...base,
        allowed: ['next'],
        targets: [],
        lock: { intent: 'steer', target: 'exec_research' },
      }),
    ).toEqual({ intent: 'steer', target: 'exec_research', blocked: 'target' });
  });

  it('blocks a locked instruction once the run has ended', () => {
    expect(
      resolveIntent({
        ...base,
        allowed: ['next'],
        targets: [],
        running: false,
        waiting: false,
        lock: { intent: 'steer', target: 'exec_research' },
      }),
    ).toEqual({ intent: 'steer', target: 'exec_research', blocked: 'run' });
  });

  it('honours an explicit instruction choice that is possible now', () => {
    expect(resolveIntent({ ...base, chosen: 'steer', chosenTarget: 'exec_writer' })).toEqual({
      intent: 'steer',
      target: 'exec_writer',
      blocked: null,
    });
    expect(resolveIntent({ ...base, chosen: 'steer' })).toEqual({
      intent: 'steer',
      target: 'exec_research',
      blocked: null,
    });
    // Chosen while possible, then no longer: back to the next request, as nothing was typed.
    expect(resolveIntent({ ...base, chosen: 'steer', allowed: ['next'], targets: [] })).toEqual({
      intent: 'queue',
      target: null,
      blocked: null,
    });
  });
});
