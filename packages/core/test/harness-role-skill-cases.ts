/** Fixture keys stand for exact package-hash/entry pairs, not lookup by skill name. */
interface RoleSkillCase {
  title: string;
  skills?: string[];
  /** Required, layer-inherited and picked entries: what any resolver must return. */
  expected?: string[];
  /**
   * The other usable library entries the server's resolver adds for its own fixture library
   * (docs/specs/harness-contract.md, "그 밖에 쓸 수 있는 스킬"). Only the server test asserts them.
   */
  others?: string[];
  problem?: 'missing' | 'disabled' | 'untrusted' | 'name_conflict' | 'execution_policy_required';
  bound?: boolean;
  defaults?: boolean;
}

const library = ['first', 'second', 'conflict', 'mandatory', 'explicit', 'optional', 'new'];
const except = (...names: string[]) => library.filter((name) => !names.includes(name));

export const roleSkillCases: RoleSkillCase[] = [
  { title: 'no selection or binding bypasses resolution' },
  {
    title: 'both optional skills',
    skills: ['first', 'second'],
    expected: ['first', 'second'],
    others: except('first', 'second'),
  },
  {
    title: 'one exact selection',
    skills: ['second'],
    expected: ['second'],
    others: except('second'),
  },
  { title: 'an empty selection', skills: [], expected: [], others: library },
  {
    title: 'an empty selection keeps inherited skills; their names win over the library',
    skills: [],
    defaults: true,
    expected: ['required', 'mandatory', 'explicit', 'optional'],
    others: ['first', 'second', 'new'],
  },
  {
    title: 'a selected inherited explicit entry stays explicit',
    skills: ['explicit'],
    bound: true,
    defaults: true,
    expected: ['required', 'mandatory', 'explicit', 'optional'],
    others: ['first', 'second', 'new'],
  },
  {
    title: 'a bound role with no selection retains its inherited entries',
    bound: true,
    defaults: true,
    expected: ['required', 'mandatory', 'explicit', 'optional'],
    others: ['first', 'second', 'new'],
  },
  {
    title: 'a newer installation does not replace a pinned entry',
    skills: ['old'],
    expected: ['old'],
    others: except('new'),
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
