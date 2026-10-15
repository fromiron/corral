import type { Clock, Scheduler } from '@corral/contracts';

/** Time that only moves when the test says so (Test-Strategy §3). Timers fire on `advance`. */
export class FakeClock implements Clock, Scheduler {
  private readonly startMs: number;
  private elapsedMs = 0;
  private timers: { dueMs: number; fn: () => void }[] = [];

  constructor(startIso = '2026-10-15T00:00:00.000Z') {
    this.startMs = Date.parse(startIso);
    if (Number.isNaN(this.startMs)) throw new RangeError(`invalid start time: ${startIso}`);
  }

  nowIso(): string {
    return new Date(this.startMs + this.elapsedMs).toISOString();
  }

  monotonicMs(): number {
    return this.elapsedMs;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError('FakeClock cannot move backwards');
    this.elapsedMs += ms;
    const due = this.timers.filter((t) => t.dueMs <= this.elapsedMs);
    this.timers = this.timers.filter((t) => t.dueMs > this.elapsedMs);
    for (const timer of due.sort((a, b) => a.dueMs - b.dueMs)) timer.fn();
  }

  after(ms: number, fn: () => void): () => void {
    const timer = { dueMs: this.elapsedMs + ms, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }
}
