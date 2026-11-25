import type { NewSessionEntry, WorkSession } from './repository/index.ts';

export interface PullRequestWatchState {
  headSha: string;
  failedChecks: string[];
  conflicting: boolean;
}

export interface WatchedCheck {
  name: string;
  url: string | null;
  failed: boolean;
}

export interface PullRequestWatchRead {
  headSha: string;
  checks: WatchedCheck[] | null;
  mergeable: string;
}

export type PullRequestWatchChange =
  | { kind: 'checks_failed'; failed: WatchedCheck[] }
  | { kind: 'conflicting' };

export const PULL_REQUEST_WAKE_LIMIT = 3;
const LISTED_ITEMS = 10;

export function evaluatePullRequestWatch(
  state: PullRequestWatchState | null,
  read: PullRequestWatchRead,
): { changes: PullRequestWatchChange[]; next: PullRequestWatchState } {
  const failedNow = (read.checks ?? []).filter((check) => check.failed);
  if (!state)
    return {
      changes: [],
      next: {
        headSha: read.headSha,
        failedChecks: failedNow.map((check) => check.name),
        conflicting: read.mergeable === 'CONFLICTING',
      },
    };
  const changes: PullRequestWatchChange[] = [];
  const headMoved = read.headSha !== state.headSha;
  let failedChecks = headMoved ? [] : state.failedChecks;
  // Hosts can return no checks on a read failure; the prior state stands.
  if (read.checks && read.checks.length > 0) {
    const newlyFailed = failedNow.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) changes.push({ kind: 'checks_failed', failed: newlyFailed });
    failedChecks = failedNow.map((check) => check.name);
  }
  // Like a failed check, a conflict a push did not resolve is news for the new head.
  const toldConflict = !headMoved && state.conflicting;
  if (read.mergeable === 'CONFLICTING' && !toldConflict) changes.push({ kind: 'conflicting' });
  // UNKNOWN is a host still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    read.mergeable === 'UNKNOWN' ? toldConflict : read.mergeable === 'CONFLICTING';
  return { changes, next: { headSha: read.headSha, failedChecks, conflicting } };
}

function listed<T>(items: readonly T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

export function pullRequestWakeText(input: {
  number: number;
  url: string;
  base: string;
  headSha: string;
  changes: readonly PullRequestWatchChange[];
}): string {
  const commit = ` on ${input.headSha.slice(0, 7)}`;
  const lines = input.changes.flatMap((change) =>
    change.kind === 'checks_failed'
      ? [
          `- Checks failed${commit}:`,
          ...listed(
            change.failed,
            (check) => `  - ${check.name}${check.url ? ` ${check.url}` : ''}`,
          ),
        ]
      : [`- The branch now conflicts with ${input.base}.`],
  );
  return [
    `Note from Corral, not from the person: an update on pull request #${input.number} (${input.url}), which Corral is watching.`,
    ...lines,
    '',
    'Look into each item and act on it as your task requires. End your turn when you are done.',
  ].join('\n');
}

export function pullRequestWakeEntry(
  session: WorkSession,
  wake: { number: number; headSha: string; text: string },
): NewSessionEntry | null {
  const source = [...session.entries]
    .reverse()
    .find((entry) => entry.start && (entry.intent === 'next' || entry.intent === 'queue'));
  if (!source?.start) return null;
  return {
    intent: 'queue',
    state: 'queued',
    text: wake.text,
    start: source.start,
    ...(source.permissionMode ? { permissionMode: source.permissionMode } : {}),
    pullRequest: { number: wake.number, headSha: wake.headSha },
  };
}
