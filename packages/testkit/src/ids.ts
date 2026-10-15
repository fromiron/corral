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
};

/** Predictable IDs: `run_0001`, `run_0002`, `task_0001`, … */
export class SequentialIdFactory implements IdFactory {
  private readonly counters = new Map<IdKind, number>();

  next(kind: IdKind): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return `${PREFIX[kind]}_${String(n).padStart(4, '0')}`;
  }
}
