import {
  REVIEW_LOOP_PATTERNS,
  TEAM_LIMITS,
  TEAM_PATTERNS,
  TEAM_SLOTS,
  type TeamPattern,
  TeamPlan,
} from '@corral/contracts';
import { requestsWorkObservation, withWorkObservation } from '@corral/core';

// one model request turns a goal into a team plan. The answer is untrusted text: only
// a JSON object that passes the TeamPlan contract is used, and the text itself is never sent
// back or logged. Tools and wiring are not part of the plan.

// A plan is at most a few hundred tokens; the rest is room for a reasoning model, whose
// thinking counts against the same allowance and otherwise cuts the answer off.
export const DRAFT_MAX_OUTPUT_TOKENS = 3000;
export const DRAFT_TIMEOUT_MS = 60_000;

const quoted = (patterns: readonly TeamPattern[]) => patterns.map((p) => `"${p}"`).join(', ');

/** What each pattern's team does and when it fits; the roles come from the contract. */
const PATTERN_USE: Record<TeamPattern, string> = {
  single:
    'one agent does the whole task. Questions, explanations, translations, small or local edits and other short tasks.',
  write_review:
    'a planner outlines, a writer writes and a reviewer reviews in rounds. Documents and messages written from what the goal supplies, when they need a careful check.',
  research_write_review:
    'a researcher gathers facts and sources first, then write and review in rounds. Writing that depends on outside facts, sources or a comparison, when no choice between options is asked for.',
  implement_review:
    'an implementer changes the code, then a reviewer checks the change and sends it back until it passes. A code change whose shape the goal already gives: one behavior, check, field or endpoint added or changed.',
  feature:
    'a designer reads the code and settles the shape of the change first, then an implementer builds it and a verifier runs it against the criteria and sends it back until it passes. Code changes whose shape has to be worked out before building: a feature that spans several parts, a migration, staged or multi-part work.',
  bug_fix:
    'an investigator reproduces the problem and finds its cause, a fixer fixes the cause, and a verifier runs the same reproduction and sends the fix back until the problem is gone. Code that fails, crashes or behaves wrongly and must be repaired.',
  refactor:
    'one step pins the current behavior with tests, a second changes the structure, and a verifier checks with the pinned tests that behavior did not change, sending it back until it holds. Restructuring, consolidating or cleaning up code without changing what it does.',
  performance:
    'an investigator measures a baseline and finds where the time goes, an implementer improves it, and a verifier measures again the same way and sends it back until the number is better. Making code faster or lighter when the goal says what is slow.',
  adversarial_review:
    'a scope step says what the change is meant to do and where to look, two challengers on different models try to break it at the same time, then a judge keeps only the problems they showed. Reviewing existing code or a change without modifying it.',
  tech_decision:
    'a framer states the question and two options, each option is researched at the same time, then a judge weighs them on the same points and picks one. Choosing between technical options.',
  code_investigation:
    'a scope step sets what to look at, one step traces how the code works while another finds in the record why it came to be that way, then a writer turns both into one explanation. Explaining how existing code works or why it is the way it is, without changing it.',
};

export const TEAM_PLAN_PROMPT = `Fields (use exactly these, no others):
- name: a short title for the team (at most ${TEAM_LIMITS.name} characters)
- pattern: one of ${quoted(TEAM_PATTERNS)}
- brief: the task as the team will receive it (at most ${TEAM_LIMITS.brief} characters)
- criteria: 1 to 6 short checks the result must pass (each at most ${TEAM_LIMITS.criterion} characters)
- roles: one entry for each role of the pattern, no more and no fewer: {"slot": role, "name": a short job title (at most ${TEAM_LIMITS.roleName} characters), "duty": what this role does, in one or two sentences (at most ${TEAM_LIMITS.duty} characters)}
- reviewRounds: 1 to 3, only for ${quoted(REVIEW_LOOP_PATTERNS)}; leave it out for the other patterns
- finalApproval: true or false; false unless the goal itself asks that a person approve the result before it is final
- outrider: optional. Use "consultation" when workers should ask a shared expert for advice when needed, and "artifact_review" when they should ask for feedback on a draft and then revise and submit it themselves. Use "clarify_review" when the goal asks for review before submission and does not say whether passing is necessary. Use "required_review" only when the goal explicitly says passing review is required to submit. Omit outrider if the goal makes none of these requests.
- observeWork: optional. Set to true only if the goal explicitly asks the Outrider to observe the workers while they work. Omit for on-request advice or artifact review alone, or if the goal rules out automatic observation. This is independent of outrider.
- Describe who produces and submits each result in the role's duty. An on-request Outrider is shared advice, not one of the roles in the pattern. Do not add a sequential reviewer or review loop for that advice alone. A worker who revises and submits their own result needs no separate reviewer.

Patterns:
${TEAM_PATTERNS.map((pattern) => `- "${pattern}": ${PATTERN_USE[pattern]} Roles: ${TEAM_SLOTS[pattern].join(', ')}`).join('\n')}

Pick the smallest pattern that fits. An on-request adviser or manuscript feedback does not require planning, research, implementation or sequential review roles. Use "single" for the underlying task unless the goal asks for distinct roles or a work sequence. A small edit that needs no review round (a line or two, wording, comments, a rename) is "single" even when it changes code or documents.`;

export const DRAFT_SYSTEM_PROMPT = `You design a small team of AI agents for a goal. Answer with one JSON object and nothing else.

${TEAM_PLAN_PROMPT} Write in the language of the goal.`;

/** The plan in a model's answer, or null when there is none that fits. */
export function planFromAnswer(text: string, goal?: string): TeamPlan | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  // An answer that leaves the approval out asks for none.
  const parsed = TeamPlan.safeParse(
    value && typeof value === 'object' && !Array.isArray(value)
      ? { finalApproval: false, ...value }
      : value,
  );
  if (!parsed.success) return null;
  return goal === undefined
    ? parsed.data
    : withWorkObservation(parsed.data, requestsWorkObservation(goal));
}
