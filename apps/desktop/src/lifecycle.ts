/** A desktop projection of Coordinator activity; it never decides run state. */
export interface DesktopRun {
  runId: string;
  sessionId: string | null;
  status: string;
  controlRevision?: number;
  title?: string;
}

export const terminalRunStatuses = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export function runRoute(run: DesktopRun): string {
  return run.sessionId
    ? `/sessions/${encodeURIComponent(run.sessionId)}?panel=run&view=run&run=${encodeURIComponent(run.runId)}`
    : `/runs/${encodeURIComponent(run.runId)}`;
}

/** One blocker for the host, even when several sessions are working. */
export class RunSleepBlocker {
  private id: number | null = null;
  private readonly power: {
    start(type: 'prevent-app-suspension'): number;
    stop(id: number): void;
  };
  constructor(power: {
    start(type: 'prevent-app-suspension'): number;
    stop(id: number): void;
  }) {
    this.power = power;
  }

  update(runs: readonly DesktopRun[], enabled: boolean, includeWaiting: boolean) {
    const busy =
      enabled &&
      runs.some(
        (run) =>
          !terminalRunStatuses.has(run.status) &&
          (includeWaiting || !['paused', 'awaiting_user'].includes(run.status)),
      );
    if (busy && this.id === null) this.id = this.power.start('prevent-app-suspension');
    else if (!busy) this.dispose();
  }

  dispose() {
    if (this.id !== null) this.power.stop(this.id);
    this.id = null;
  }
}
