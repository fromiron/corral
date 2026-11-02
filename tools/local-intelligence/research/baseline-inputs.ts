import type { MeetingSelectionInput } from '../../../packages/contracts/src/index.ts';
import type { MeetingInput } from './data.ts';

/** An explicitly supplied runtime view is authoritative, even if its text is empty. */
export function effortBaselineInput(row: { oldText?: unknown; runtimeView?: unknown }) {
  if (Object.hasOwn(row, 'runtimeView')) {
    const view = row.runtimeView;
    if (typeof view !== 'object' || view === null || Array.isArray(view))
      throw new Error('explicit runtime view must be an object');
    if (Object.hasOwn(view, 'legacyText')) {
      const text = (view as Record<string, unknown>).legacyText;
      if (typeof text !== 'string')
        throw new Error('explicit runtime legacy text must be a string');
      return { text, source: 'runtimeView.legacyText' as const };
    }
  }
  if (typeof row.oldText !== 'string') throw new Error('legacy effort text must be a string');
  return { text: row.oldText, source: 'oldText' as const };
}

/** The message, every role, then each person's latest turn; each slot stays even if empty. */
export function legacyCosineTexts(input: MeetingSelectionInput) {
  const clean = (text: string) => [...text.trim()].slice(0, 1800).join('');
  return [
    clean(input.message),
    ...input.participants.map((p) => clean(p.prompt)),
    ...input.participants.map((p) =>
      clean(input.history.findLast((h) => h.participantId === p.participantId)?.text ?? ''),
    ),
  ];
}

export function meetingCosineInputs(input: MeetingInput) {
  const turns = input.turns.slice(-12);
  return {
    query: input.message,
    participants: input.participants.map((person) => ({
      id: person.id,
      role: [person.name, person.role].filter(Boolean).join('\n'),
      history: turns.filter((turn) => turn.speakerId === person.id).map((turn) => turn.text),
    })),
  };
}

/** Fixed before policy scoring; the weight multiplies name/role similarity. */
export const ROLE_HISTORY_WEIGHTS = [0, 0.25, 0.5, 0.75, 1] as const;

export function historyCosineReferences(
  ids: string[],
  roleScores: number[],
  historyScores: number[],
) {
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    roleScores.length !== ids.length ||
    historyScores.length !== ids.length ||
    !roleScores.every(Number.isFinite) ||
    !historyScores.every(Number.isFinite)
  )
    throw new Error('cosine scores must match a nonempty unique participant roster');
  const select = (scores: number[]) => [ids[scores.indexOf(Math.max(...scores))]!];
  return {
    maxHistoryCosine: select(historyScores),
    ...Object.fromEntries(
      ROLE_HISTORY_WEIGHTS.map((weight) => [
        `roleHistoryCosine_${weight}`,
        select(
          roleScores.map((role, index) => weight * role + (1 - weight) * historyScores[index]!),
        ),
      ]),
    ),
  };
}
