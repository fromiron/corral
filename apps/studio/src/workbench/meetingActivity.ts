import type { MeetingView } from '@corral/contracts';
import { startedAnswer } from './meetingTimeline.ts';

// What a meeting's activity bar says (workbench.md, the meeting's composer;
// features/composer-flow.md "활동 바"): read from the meeting's view and from what is on screen.
// The closed line says the first of: a continue card out of view, an answer running out of view,
// the last replies' count once nothing runs. It says nothing a row on screen already says.

type Answer = MeetingView['rounds'][number]['answers'][number];

/** An answer that is not a reply (as the answer rows say it). */
const FAILED = new Set<Answer['status']>(['failed', 'refused', 'interrupted', 'not_started']);

/** The continue card's place on screen, as `data-presence-label`. */
export const HOLD_LABEL = 'meeting:hold';
/** A running answer's row on screen, as `data-presence-label`. */
export const answerLabel = (runId: string) => `run:${runId}` as const;

export type MeetingLine =
  /** The continue card waits out of view. */
  | { kind: 'hold'; waiting: number }
  /** An answer runs out of view: who answers. */
  | { kind: 'answering'; participantId: string; runId: string; waiting: number }
  /** Answers run, and their rows say who: the line says only that something runs. */
  | { kind: 'busy'; waiting: number }
  /** Nothing runs: the last replies, and how many failed. */
  | { kind: 'summary'; answered: number; failed: number };

export interface MeetingRow {
  participantId: string;
  /** Answering now: its run. */
  runId: string | null;
  /** Its turns still to come. */
  waiting: number;
}

/** The answers running, then those waiting their turn, in the order they were given. */
function answersOf(view: MeetingView) {
  const running: Answer[] = [];
  const waiting: Answer[] = [];
  for (const round of view.rounds)
    for (const answer of round.answers) {
      if (answer.status === 'running') running.push(answer);
      else if (answer.status === 'waiting') waiting.push(answer);
    }
  return { running, waiting };
}

/**
 * The closed line; null while the meeting has nothing to say (nothing ran yet). `open`: the
 * rows of who answers and who waits are on screen, so the line does not say them again.
 */
export function meetingLine(
  view: MeetingView,
  { visible, open }: { visible: ReadonlySet<string>; open: boolean },
): MeetingLine | null {
  const { running, waiting } = answersOf(view);
  // People waiting to speak: each once, however many turns, and not one already answering.
  const answering = new Set(running.map((answer) => answer.participantId));
  const people = new Set(
    waiting
      .map((answer) => answer.participantId)
      .filter((participantId) => !answering.has(participantId)),
  );
  const count = open ? 0 : people.size;
  if (view.hold && !visible.has(HOLD_LABEL)) return { kind: 'hold', waiting: count };
  const unseen = open
    ? undefined
    : running.find((answer) => answer.runId && !visible.has(answerLabel(answer.runId)));
  if (unseen?.runId)
    return {
      kind: 'answering',
      participantId: unseen.participantId,
      runId: unseen.runId,
      waiting: count,
    };
  if (running.length || waiting.length) return { kind: 'busy', waiting: count };
  // At rest: the last message anyone was asked to answer. One for no one says so on its own
  // line, so it is not counted here.
  const last = view.rounds.findLast((round) => round.answers.length > 0);
  if (!last) return null;
  const answered = last.answers.filter((answer) => answer.status === 'answered').length;
  // One that never started (stopped or skipped before its turn) did not fail.
  const failed = last.answers.filter(
    (answer) => startedAnswer(answer) && FAILED.has(answer.status),
  ).length;
  // Nothing received: no count to say.
  if (!answered && !failed) return null;
  return { kind: 'summary', answered, failed };
}

/** One row per participant answering or waiting: the one answering first, then by first turn. */
export function meetingRows(view: MeetingView): MeetingRow[] {
  const { running, waiting } = answersOf(view);
  const rows = new Map<string, MeetingRow>();
  for (const answer of running)
    if (!rows.has(answer.participantId))
      rows.set(answer.participantId, {
        participantId: answer.participantId,
        runId: answer.runId,
        waiting: 0,
      });
  for (const answer of waiting) {
    const row = rows.get(answer.participantId) ?? {
      participantId: answer.participantId,
      runId: null,
      waiting: 0,
    };
    row.waiting += 1;
    rows.set(answer.participantId, row);
  }
  return [...rows.values()];
}
