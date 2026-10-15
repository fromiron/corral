import type { Clock } from '@corral/contracts';

/** Time that only moves when the test says so (Test-Strategy §3). */
export class FakeClock implements Clock {
  private readonly startMs: number;
  private elapsedMs = 0;

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
  }
}
