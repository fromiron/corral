/** A desktop projection of Coordinator activity; it never decides run state. */
export interface DesktopRun {
  runId: string;
  sessionId: string | null;
  status: string;
  controlRevision?: number;
  title?: string;
}

export const terminalRunStatuses = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

/** The words of docs/specs/features/presence.md for a Run that has not ended; anything else is "Preparing". */
export function trayRunState(status: string, ko: boolean): string {
  const words: Record<string, [string, string]> = {
    created: ['Starting', '시작하는 중'],
    validating: ['Starting', '시작하는 중'],
    running: ['Working', '작업 중'],
    pausing: ['Pausing', '일시정지하는 중'],
    paused: ['Paused', '일시정지됨'],
    awaiting_user: ['Waiting for you', '응답 대기'],
    cancelling: ['Stopping', '중지하는 중'],
  };
  const word = words[status];
  return word ? word[ko ? 1 : 0] : ko ? '준비 중' : 'Preparing';
}

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
