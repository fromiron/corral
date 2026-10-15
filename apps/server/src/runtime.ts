import { randomUUID } from 'node:crypto';
import type { Clock, IdFactory, IdKind } from '@corral/contracts';

// Process-level capabilities the core receives by injection (CRL-DEV-002).

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
};

/** Random ids: a restarted process must never reuse an id the previous one handed out. */
export class RandomIdFactory implements IdFactory {
  next(kind: IdKind): string {
    return `${PREFIX[kind]}_${randomUUID().replaceAll('-', '')}`;
  }
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};
