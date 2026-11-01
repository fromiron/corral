import {
  type MeetingInput,
  renderMeeting,
} from '../../../../packages/local-intelligence/src/decision/text.ts';

export const INDEXED_MEETING_VERSION = 'meeting-history-index-v1';

/** Repeats visible structural links, never a semantic summary or annotated response relation. */
export function renderIndexedMeeting(input: MeetingInput): string {
  const current = `Current user message: ${input.message}`;
  const timeline = renderMeeting(input);
  const index = [
    'Participant activity in this supplied history:',
    ...input.participants.map((participant) => {
      const turns = input.turns.filter((turn) => turn.speakerId === participant.id);
      const latest = turns.at(-1);
      return latest
        ? `${participant.id}: ${turns.map((turn) => turn.id).join(', ')}; latest ${latest.id}`
        : `${participant.id}: no prior contribution in this supplied history`;
    }),
  ].join('\n');
  // The unchanged renderer ends with this exact current-message field. Avoid searching
  // user text for a heading that it may itself quote. The index stays near the decision.
  return `${timeline.slice(0, -current.length)}${index}\n${current}`;
}
