import { createHash } from 'node:crypto';
import {
  type EffortInput,
  type MeetingInput,
  renderEffort,
  renderMeeting,
} from '../../../packages/local-intelligence/src/decision/text.ts';

export { type EffortInput, type MeetingInput, renderEffort, renderMeeting };

export const EXPERIMENT_VERSION = 'judge-research-v3';
export const INPUT_VERSION = 'judge-structured-v2';
export const LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type Split = 'fit' | 'calibration' | 'policy' | 'final';

export function assertTeacher(value: { model: string; effort?: string }): void {
  if (!value.model.trim() || !['high', 'xhigh', 'max', 'ultra'].includes(value.effort ?? '')) {
    throw new Error(
      'teacher and verifier requests require an explicit model and high-or-higher effort',
    );
  }
}

/** Call with the original scenario/conversation group, never a translation/variant ID. */
export function assignSplit(group: string): Split {
  if (!group.trim()) throw new Error('a scenario group is required');
  const fraction =
    createHash('sha256').update(`${EXPERIMENT_VERSION}:${group}`).digest().readUInt32BE(0) /
    2 ** 32;
  return fraction < 0.7
    ? 'fit'
    : fraction < 0.8
      ? 'calibration'
      : fraction < 0.9
        ? 'policy'
        : 'final';
}

/** A second view makes each candidate's earlier contributions directly addressable. */
export function renderCandidateHistory(input: MeetingInput, candidateId: string): string {
  const participant = input.participants.find((p) => p.id === candidateId);
  if (!participant) throw new Error('candidate is not a participant');
  return [
    'Task: decide whether this participant should answer the current group message.',
    `Candidate: ${participant.id}: ${participant.name}; role: ${participant.role}`,
    'This participant’s contributions, in visible order:',
    ...input.turns
      .filter((t) => t.speakerId === candidateId)
      .map((t) => `[${t.id}]${t.replyTo ? ` replies to ${t.replyTo}` : ''}: ${t.text}`),
    `Current user message: ${input.message}`,
  ].join('\n');
}

/** Offsets are Unicode code points, matching fast-tokenizer offsets in Python. */
export function renderMeetingJoint(input: MeetingInput) {
  let text = `${renderMeeting(input)}\nResponse candidates:\n`;
  const spans = input.participants.map((p) => {
    const start = Array.from(text).length;
    text += `${p.id}: ${p.name}${p.role ? `; ${p.role}` : ''}\n`;
    return { id: p.id, start, end: Array.from(text).length - 1 };
  });
  text += 'Decision mode:';
  return { text, spans };
}
