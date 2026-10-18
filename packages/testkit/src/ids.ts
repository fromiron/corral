import type { IdFactory, IdKind } from '@corral/contracts';

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

/**
 * Predictable IDs: `run_0001`, `run_0002`, `task_0001`, … A namespace (`run_b0001`) stands in
 * for a restarted process, which must never hand out an ID the previous one used.
 */
export class SequentialIdFactory implements IdFactory {
  private readonly counters = new Map<IdKind, number>();
  private readonly namespace: string;

  constructor(namespace = '') {
    this.namespace = namespace;
  }

  next(kind: IdKind): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return `${PREFIX[kind]}_${this.namespace}${String(n).padStart(4, '0')}`;
  }
}
