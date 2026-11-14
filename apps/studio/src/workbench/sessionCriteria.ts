import { SESSION_CRITERIA_MAX, SESSION_CRITERION_MAX, SessionCriteria } from '@corral/core';

// A work session's completion criteria as a person types them: one per line in a multi-line
// field (docs/specs/workbench.md#세션-완료-기준). Blank lines are dropped and lines trimmed
// before sending; the limits are the ones the server holds them to.

/** The criteria in typed text: each line trimmed, blank lines dropped. */
export function criteriaLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export type CriteriaProblem = { kind: 'tooMany' } | { kind: 'tooLong'; line: number };

/** Why typed criteria cannot be saved; `line` counts the field's lines from 1. */
export function criteriaProblem(text: string): CriteriaProblem | null {
  if (criteriaLines(text).length > SESSION_CRITERIA_MAX) return { kind: 'tooMany' };
  const long = text.split('\n').findIndex((line) => line.trim().length > SESSION_CRITERION_MAX);
  return long < 0 ? null : { kind: 'tooLong', line: long + 1 };
}

/** The criteria to send, or null when they break a limit. */
export function readCriteria(text: string): string[] | null {
  const parsed = SessionCriteria.safeParse(criteriaLines(text));
  return parsed.success ? parsed.data : null;
}
