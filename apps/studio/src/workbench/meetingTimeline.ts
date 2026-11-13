import type { MeetingView } from '@corral/contracts';

// Where a meeting's items stand in its timeline (workbench.md, the meeting): an answer from when it
// started speaking; one never started has no row, whatever became of it; one stop, one line, at
// the end of the timeline as it was when the person stopped.

type Round = MeetingView['rounds'][number];
type Answer = Round['answers'][number];

/** What tells whether an answer started. */
export type StartLike = Pick<Answer, 'status' | 'runId'> & { order?: number | undefined };

/** A round's message's place (kept before rounds had a place of their own: by its index). */
export const roundOrder = (round: Round, index: number) => round.order ?? index * 7;

/**
 * Whether an answer ever started: it has its place in the transcript, which it takes when it
 * starts (or is refused as it starts), or a run (records kept before answers had a place).
 */
export const startedAnswer = (answer: StartLike) =>
  answer.status !== 'waiting' && (answer.order !== undefined || answer.runId !== null);

/** A started answer's place: when it started, or (kept before that) after its round's message. */
export const answerOrder = (round: Round, index: number, answer: Answer, n: number) =>
  answer.order ?? roundOrder(round, index) + n + 1;

/**
 * A continued round's line: where the person continued, after everything said by then. Its
 * answers, and any that were still waiting, start later and come after it.
 */
export const continuedOrder = (round: Round, index: number) => roundOrder(round, index) + 0.5;

export interface StopLine {
  /** The first round the stop stopped. */
  roundId: string;
  order: number;
}

/**
 * One line per stop, after everything there was when it came. A stop stops every message still
 * answering at once (their stop times a moment apart): a stopped round made before an earlier
 * stopped round's stop was stopped by that same stop, and one made after it by a later stop.
 */
export function stopLines(view: MeetingView): StopLine[] {
  const stopped = view.rounds
    .map((round, index) => ({ round, index, at: round.stoppedAt }))
    .filter((item): item is { round: Round; index: number; at: string } => item.at !== null)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.index - b.index));
  const stops: { at: string; first: { round: Round; index: number } }[] = [];
  for (const item of stopped) {
    const last = stops.at(-1);
    if (last && item.round.createdAt <= last.at) {
      if (item.index < last.first.index) last.first = item;
    } else stops.push({ at: item.at, first: item });
  }
  return stops.map(({ at, first }) => {
    // What there was when it came: the messages made by then and the answers that had started.
    const places = view.rounds.flatMap((round, index) =>
      round.createdAt <= at || round === first.round
        ? [
            roundOrder(round, index),
            ...round.answers.flatMap((answer, n) =>
              startedAnswer(answer) ? [answerOrder(round, index, answer, n)] : [],
            ),
          ]
        : [],
    );
    // After a continued line at the same place, too.
    return { roundId: first.round.roundId, order: Math.max(...places) + 0.75 };
  });
}
