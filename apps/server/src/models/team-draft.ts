import { TEAM_LIMITS, TEAM_PATTERNS, TEAM_SLOTS, TeamPlan } from '@corral/contracts';

// one model request turns a goal into a team plan. The answer is untrusted text: only
// a JSON object that passes the TeamPlan contract is used, and the text itself is never sent
// back or logged. Tools and wiring are not part of the plan.

export const DRAFT_MAX_OUTPUT_TOKENS = 1500;
export const DRAFT_TIMEOUT_MS = 60_000;

export const DRAFT_SYSTEM_PROMPT = `You design a small team of AI agents for a goal. Answer with one JSON object and nothing else.

Fields:
- name: a short title for the team (at most ${TEAM_LIMITS.name} characters)
- pattern: one of ${TEAM_PATTERNS.map((p) => `"${p}"`).join(', ')}
  - "single": one agent does the whole task. Roles: ${TEAM_SLOTS.single.join(', ')}
  - "write_review": a planner outlines, a writer writes and a reviewer reviews in rounds. Roles: ${TEAM_SLOTS.write_review.join(', ')}
  - "research_write_review": a researcher gathers facts and sources first, then write and review in rounds. Roles: ${TEAM_SLOTS.research_write_review.join(', ')}
- brief: the task as the team will receive it (at most ${TEAM_LIMITS.brief} characters)
- criteria: 1 to 6 short checks the result must pass
- roles: one entry per role of the pattern: {"slot": role, "name": a short job title, "duty": what this role does, in one or two sentences}
- reviewRounds: 1 to 3 for the patterns with review; leave it out for "single"
- finalApproval: true when a person should approve the final result

Pick the smallest pattern that fits. Write in the language of the goal.`;

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
