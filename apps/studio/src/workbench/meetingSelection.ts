import type { MeetingSelection } from '@corral/contracts';
import { type StartLike, startedAnswer } from './meetingTimeline.ts';

// What a person's message says about who receives it (workbench.md, the meeting's timeline):
// read from how the round chose its recipients (features/local-intelligence.md, the selection
// record). The screen words it; nothing stored is drawn as it is.

/** The meeting picked: the address rules, the selector and its policy, or the fallback. */
const AUTOMATIC = new Set<MeetingSelection['strategy']>(['address', 'selector', 'fallback']);

export type RoundMeta =
  /** Chosen by the person or called by @mention: the receivers by name. */
  | { kind: 'names'; names: string[] }
  /** The meeting picked who answers; the answers name them. */
  | { kind: 'auto' }
  /** Nobody was to answer; `explained` when the meeting, not the person, picked nobody. */
  | { kind: 'noReply'; explained: boolean }
  /**
   * It had receivers, but no answer ever started: a later message was taken first, or the replies
   * were stopped before.
   */
  | { kind: 'skipped' };

interface RoundLike {
  kind: 'all' | 'mention' | 'rebuttal' | 'secretary';
  participantIds: readonly string[];
  answers: readonly StartLike[];
  selection?: MeetingSelection | undefined;
}

/**
 * The meta line's word on who receives a round; null when nothing is known to say (a general
 * message kept before rounds kept their selection). `nameOf` names a participant the meeting
 * still has; one it no longer has is named by its ID.
 */
export function roundMeta(
  round: RoundLike,
  nameOf: (id: string) => string | undefined,
): RoundMeta | null {
  const names = () => round.participantIds.map((id) => nameOf(id) ?? id);
  const { selection } = round;
  if (!selection)
    return (round.kind === 'mention' || round.kind === 'secretary') && round.participantIds.length
      ? { kind: 'names', names: names() }
      : null;
  if (round.answers.length === 0)
    return round.participantIds.length
      ? { kind: 'skipped' }
      : { kind: 'noReply', explained: AUTOMATIC.has(selection.strategy) };
  // Nothing started and nothing waits any more: however they were chosen, none will answer.
  if (
    round.participantIds.length &&
    !round.answers.some((answer) => startedAnswer(answer) || answer.status === 'waiting')
  )
    return { kind: 'skipped' };
  if (AUTOMATIC.has(selection.strategy)) return { kind: 'auto' };
  return { kind: 'names', names: names() };
}

export interface RankedScore {
  participantId: string;
  name: string;
  score: number;
  picked: boolean;
}

/**
 * The selector's scores as a ranking, highest first (ties keep the order they were kept in).
 * A score that is not a finite number, or a participant the meeting no longer has, is left out.
 */
export function rankedScores(
  selection: MeetingSelection | undefined,
  picked: readonly string[],
  nameOf: (id: string) => string | undefined,
): RankedScore[] {
  return (selection?.scores ?? [])
    .flatMap(({ participantId, score }) => {
      const name = nameOf(participantId);
      return name !== undefined && Number.isFinite(score)
        ? [{ participantId, name, score, picked: picked.includes(participantId) }]
        : [];
    })
    .sort((a, b) => b.score - a.score);
}
