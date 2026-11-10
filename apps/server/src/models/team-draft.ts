import {
  REVIEW_LOOP_PATTERNS,
  TEAM_LIMITS,
  TEAM_PATTERNS,
  TEAM_SLOTS,
  type TeamPattern,
  TeamPlan,
} from '@corral/contracts';

// one model request turns a goal into a team plan. The answer is untrusted text: only
// a JSON object that passes the TeamPlan contract is used, and the text itself is never sent
// back or logged. Tools and wiring are not part of the plan.

export const DRAFT_MAX_OUTPUT_TOKENS = 1500;
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
    'an implementer changes the code, then a reviewer checks the change and sends it back until it passes. Adding or changing a feature in code when the change is clear.',
  plan_implement_review:
    'a planner reads the code and writes the steps and files to change, then implement and review in rounds. Code changes that need a plan first: a design, a migration, staged or multi-part work.',
  bug_fix:
    'an investigator reproduces the problem and finds its cause, a fixer fixes the cause, and a reviewer checks the fix in rounds. Code that fails, crashes or behaves wrongly and must be repaired.',
  parallel_review:
    'a scope step lists what to look at, correctness and security reviews run at the same time, then a synthesis merges their findings into one report. Reviewing existing code or a change without modifying it.',
  tech_decision:
    'a framer states the question and two options, each option is researched at the same time, then a comparison recommends one. Choosing between technical options.',
};

export const DRAFT_SYSTEM_PROMPT = `You design a small team of AI agents for a goal. Answer with one JSON object and nothing else.

Fields (use exactly these, no others):
- name: a short title for the team (at most ${TEAM_LIMITS.name} characters)
- pattern: one of ${quoted(TEAM_PATTERNS)}
- brief: the task as the team will receive it (at most ${TEAM_LIMITS.brief} characters)
- criteria: 1 to 6 short checks the result must pass (each at most ${TEAM_LIMITS.criterion} characters)
- roles: one entry for each role of the pattern, no more and no fewer: {"slot": role, "name": a short job title (at most ${TEAM_LIMITS.roleName} characters), "duty": what this role does, in one or two sentences (at most ${TEAM_LIMITS.duty} characters)}
- reviewRounds: 1 to 3, only for ${quoted(REVIEW_LOOP_PATTERNS)}; leave it out for the other patterns
- finalApproval: false unless the goal itself asks that a person approve the result before it is final

Patterns:
${TEAM_PATTERNS.map((pattern) => `- "${pattern}": ${PATTERN_USE[pattern]} Roles: ${TEAM_SLOTS[pattern].join(', ')}`).join('\n')}

Pick the smallest pattern that fits. A small edit that needs no review round (a line or two, wording, comments, a rename) is "single" even when it changes code or documents. Write in the language of the goal.`;

/** The plan in a model's answer, or null when there is none that fits. */
export function planFromAnswer(text: string): TeamPlan | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = TeamPlan.safeParse(value);
  return parsed.success ? parsed.data : null;
}
