import { randomUUID } from 'node:crypto';
import type { Clock, IdFactory, IdKind, Scheduler } from '@corral/contracts';

// Process-level capabilities the core receives by injection.

const PREFIX: Record<IdKind, string> = {
  run: 'run',
  event: 'evt',
  task: 'task',
  execution: 'exec',
  model_call: 'call',
  context_snapshot: 'ctx',
  directive: 'dir',
  tool_call: 'tool',
  artifact: 'art',
  artifact_version: 'artv',
  criteria_version: 'crit',
  iteration: 'iter',
  effect: 'eff',
  question: 'q',
  approval: 'appr',
  preparation: 'prep',
  decision: 'dec',
};

/** Random ids: a restarted process must never reuse an id the previous one handed out. */
export class RandomIdFactory implements IdFactory {
  next(kind: IdKind): string {
    return `${PREFIX[kind]}_${randomUUID().replaceAll('-', '')}`;
  }
}

/** Wall-clock deadlines (question timeouts). */
export const systemTimers: Scheduler = {
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};
