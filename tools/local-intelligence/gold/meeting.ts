// Rebuilds, for each past human message, the exact input the selector would have received at that
// moment (packages/core/src/meeting.ts): posted text from earlier rounds only, in recorded order.
import type { MeetingSelectionInput } from '../../../packages/contracts/src/index.ts';
import { scrub } from './scrub.ts';

interface StoredAnswer {
  participantId: string;
  runId: string | null;
  state: string;
  order?: number;
}
interface StoredRound {
  kind: string;
  message?: string | null;
  participantIds: string[];
  answers: StoredAnswer[];
  order?: number;
  replyTo?: unknown;
}
export interface StoredMeeting {
  id?: string;
  config: { participants: { participantId: string; name: string; prompt?: string }[] };
  rounds: StoredRound[];
}
export interface MeetingCase {
  session: string;
  input: MeetingSelectionInput;
  names: Record<string, string>;
  /** Recipients the person chose without typing a mention: a label needing no later review. */
  chosen?: string[];
}

const roundOrder = (round: StoredRound, index: number) => round.order ?? index;

export function meetingItems(
  meeting: StoredMeeting,
  answerText: (runId: string) => string | null,
): MeetingCase[] {
  const participants = meeting.config.participants.map(({ participantId, prompt }) => ({
    participantId,
    prompt: scrub(prompt ?? ''),
  }));
  const names = Object.fromEntries(
    meeting.config.participants.map((p) => [p.participantId, scrub(p.name)]),
  );
  const cases: MeetingCase[] = [];
  meeting.rounds.forEach((round, index) => {
    const typedMention = round.message?.includes('@');
    if (
      !round.message ||
      round.replyTo ||
      !['all', 'mention'].includes(round.kind) ||
      (round.kind === 'mention' && typedMention)
    )
      return;
    const history: { order: number; participantId: string | null; text: string }[] = [];
    const start = Math.max(0, index - 6);
    for (const [at, past] of meeting.rounds.slice(start, index).entries()) {
      const position = start + at;
      if (past.message)
        history.push({
          order: roundOrder(past, position),
          participantId: null,
          text: scrub(past.message.slice(0, 2000)),
        });
      for (const [n, answer] of past.answers.entries()) {
        const text = answer.state === 'started' && answer.runId ? answerText(answer.runId) : null;
        if (text)
          history.push({
            order: answer.order ?? roundOrder(past, position) + n + 1,
            participantId: answer.participantId,
            text: scrub(text.slice(0, 2000)),
          });
      }
    }
    cases.push({
      session: meeting.id ?? 'meeting',
      names,
      input: {
        message: scrub(round.message),
        participants,
        history: history
          .sort((a, b) => a.order - b.order)
          .slice(-12)
          .map(({ participantId, text }) => ({ participantId, text })),
      },
      ...(round.kind === 'mention' ? { chosen: round.participantIds } : {}),
    });
  });
  return cases;
}
