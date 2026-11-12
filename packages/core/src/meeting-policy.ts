import {
  type MeetingSelectionReason,
  type MeetingSelectionScore,
  type MeetingSelectorResult,
  SECRETARY_ID,
} from '@corral/contracts';

// The selector only scores; this policy decides who answers and how many. It reads no time,
// randomness or global state, so the same inputs always give the same choice.

export interface MeetingPolicy {
  /** A `needsReply` below this chooses nobody. Only a selector that reports `needsReply` uses it. */
  needsReplyThreshold: number;
}

export const DEFAULT_MEETING_POLICY: MeetingPolicy = { needsReplyThreshold: 0.5 };

export type SpeakerChoice = {
  participantIds: string[];
  /** The scores the policy kept; present when the selector's result was used. */
  scores?: MeetingSelectionScore[];
} & (
  | { strategy: 'selector'; reason: MeetingSelectionReason<'selector'> }
  | { strategy: 'fallback'; reason: MeetingSelectionReason<'fallback'> }
);

export interface FallbackSpeaker {
  participantId: string | null;
  reason: Exclude<MeetingSelectionReason<'fallback'>, 'analysis_off'>;
}

/** The fallback when no usable score remains: the reply target, the recent speaker, then rotation. */
export function fallbackSpeaker(
  candidates: readonly string[],
  context: { replyTo: string | null | undefined; recent: string | null | undefined; turn: number },
): FallbackSpeaker {
  const allowed = candidates.filter((id) => id !== SECRETARY_ID);
  if (context.replyTo && allowed.includes(context.replyTo))
    return { participantId: context.replyTo, reason: 'reply_target' };
  if (context.recent && allowed.includes(context.recent))
    return { participantId: context.recent, reason: 'recent_speaker' };
  const next = allowed[context.turn % allowed.length];
  return next
    ? { participantId: next, reason: 'rotation' }
    : { participantId: null, reason: 'nobody_available' };
}

/**
 * Chooses the speakers from a selector's scores. IDs outside the candidates, IDs scored more than
 * once and nonfinite scores are dropped; the highest remaining score answers, a tie going to the
 * earlier candidate. A finite `needsReply` below the policy threshold chooses nobody, unless the
 * participant chosen is the previous speaker continuing (`continuityId`). With no usable score left,
 * the fallback answers.
 */
export function selectSpeakers(
  candidates: readonly string[],
  result: MeetingSelectorResult | null,
  policy: MeetingPolicy,
  context: {
    continuityId: string | null | undefined;
    fallback: FallbackSpeaker;
  },
): SpeakerChoice {
  const allowed = candidates.filter((id) => id !== SECRETARY_ID);
  const counts = new Map<string, number>();
  for (const { participantId } of result?.scores ?? [])
    counts.set(participantId, (counts.get(participantId) ?? 0) + 1);
  const scores = (result?.scores ?? [])
    .filter(
      ({ participantId, score }) =>
        allowed.includes(participantId) &&
        counts.get(participantId) === 1 &&
        Number.isFinite(score),
    )
    .map(({ participantId, score }) => ({ participantId, score }));
  if (!scores.length) {
    const { participantId, reason } = context.fallback;
    return { strategy: 'fallback', participantIds: participantId ? [participantId] : [], reason };
  }
  const ranked = scores.toSorted(
    (a, b) =>
      b.score - a.score || allowed.indexOf(a.participantId) - allowed.indexOf(b.participantId),
  );
  const top = ranked[0]!.participantId;
  const needsReply = result?.needsReply;
  if (
    needsReply !== undefined &&
    Number.isFinite(needsReply) &&
    needsReply < policy.needsReplyThreshold
  )
    return top === context.continuityId
      ? {
          strategy: 'selector',
          participantIds: [top],
          scores,
          reason: 'continuity',
        }
      : {
          strategy: 'selector',
          participantIds: [],
          scores,
          reason: 'no_reply_needed',
        };
  return {
    strategy: 'selector',
    participantIds: [top],
    scores,
    reason: 'top_score',
  };
}
