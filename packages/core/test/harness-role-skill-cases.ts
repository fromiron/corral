/** Fixture keys stand for exact package-hash/entry pairs, not lookup by skill name. */
interface RoleSkillCase {
  title: string;
  skills?: string[];
  expected?: string[];
  problem?: 'missing' | 'disabled' | 'untrusted' | 'name_conflict' | 'execution_policy_required';
  bound?: boolean;
  defaults?: boolean;
}

export const roleSkillCases: RoleSkillCase[] = [
  { title: 'no selection or binding bypasses resolution' },
  { title: 'both optional skills', skills: ['first', 'second'], expected: ['first', 'second'] },
  { title: 'one exact selection', skills: ['second'], expected: ['second'] },
  { title: 'an empty selection', skills: [], expected: [] },
  {
    title: 'required and mandatory survive; unselected optional drops',
    skills: [],
    defaults: true,
    expected: ['required', 'mandatory'],
  },
  {
    title: 'a selected inherited explicit entry stays explicit',
    skills: ['explicit'],
    bound: true,
    defaults: true,
    expected: ['required', 'mandatory', 'explicit'],
  },
  {
    title: 'a bound role with no selection retains its inherited entries',
    bound: true,
    defaults: true,
    expected: ['required', 'mandatory', 'explicit', 'optional'],
  },
  {
    title: 'a newer installation does not replace a pinned entry',
    skills: ['old'],
    expected: ['old'],
  },
  {
    title: 'same internal name as an inherited required skill',
    skills: ['conflict'],
    defaults: true,
    problem: 'name_conflict',
  },
  { title: 'untrusted selection', skills: ['untrusted'], problem: 'untrusted' },
  { title: 'disabled package selection', skills: ['disabled'], problem: 'disabled' },
  { title: 'missing selection', skills: ['missing'], problem: 'missing' },
  {
    title: 'native extension over the minimal policy',
    skills: [],
    problem: 'execution_policy_required',
  },
];
