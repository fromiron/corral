import { describe, expect, it } from 'vitest';
import { TeamCatalog, TeamComposition } from '../src/index.ts';

// A team the model composes from the editor's catalog (docs/specs/features/team-assistant.md,
// "팀 구성 제안"): seats that name a catalog agent, a duty and added skills, and a flow of three
// step kinds. Anything outside the shape makes the whole answer unusable.

const agent = (id: string) => ({
  id,
  name: `Agent ${id}`,
  changesFiles: false,
  runsCommands: false,
  output: 'draft' as const,
  skills: [],
});
const skill = (id: string) => ({ id, name: `Skill ${id}`, description: 'Does a thing.' });

const catalog = () => ({
  agents: [{ ...agent('a1'), description: 'Writes.' }, agent('a2')],
  skills: [skill('s1')],
});

const seat = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  agent: 'a1',
  name: `Seat ${id}`,
  duty: `Do the ${id} part.`,
  ...more,
});

const composition = (more: Record<string, unknown> = {}) => ({
  name: 'A team',
  brief: 'Write the notice.',
  criteria: ['Answer the brief.'],
  seats: [seat('plan'), seat('write'), seat('check')],
  flow: [{ seat: 'plan' }, { loop: { work: ['write'], judge: 'check' } }],
  ...more,
});

const rejects = (value: unknown) => expect(TeamComposition.safeParse(value).success).toBe(false);
const accepts = (value: unknown) => expect(TeamComposition.parse(value)).toBeTruthy();

describe('TeamCatalog', () => {
  it('accepts agents with and without a description, and skills', () => {
    expect(TeamCatalog.parse(catalog())).toEqual(catalog());
    expect(TeamCatalog.parse({ agents: [agent('a1')], skills: [] })).toBeTruthy();
    // A skill may come without a description; it is sent empty.
    expect(TeamCatalog.parse({ ...catalog(), skills: [{ ...skill('s1'), description: '' }] }));
  });

  it('holds 1 to 64 agents and up to 256 skills', () => {
    const agents = (n: number) => Array.from({ length: n }, (_, i) => agent(`a${i + 1}`));
    const skills = (n: number) => Array.from({ length: n }, (_, i) => skill(`s${i + 1}`));
    expect(TeamCatalog.safeParse({ agents: [], skills: [] }).success).toBe(false);
    expect(TeamCatalog.safeParse({ agents: agents(64), skills: skills(256) }).success).toBe(true);
    expect(TeamCatalog.safeParse({ agents: agents(65), skills: [] }).success).toBe(false);
    expect(TeamCatalog.safeParse({ agents: agents(1), skills: skills(257) }).success).toBe(false);
  });

  it('keeps a skill description to 300 characters', () => {
    const long = (n: number) => ({
      ...catalog(),
      skills: [{ ...skill('s1'), description: 'x'.repeat(n) }],
    });
    expect(TeamCatalog.safeParse(long(300)).success).toBe(true);
    expect(TeamCatalog.safeParse(long(301)).success).toBe(false);
  });

  it('refuses ids used twice in one list, but the lists are apart', () => {
    expect(TeamCatalog.safeParse({ agents: [agent('a1'), agent('a1')], skills: [] }).success).toBe(
      false,
    );
    expect(
      TeamCatalog.safeParse({ agents: [agent('a1')], skills: [skill('s1'), skill('s1')] }).success,
    ).toBe(false);
    expect(TeamCatalog.safeParse({ agents: [agent('x')], skills: [skill('x')] }).success).toBe(
      true,
    );
  });

  it('refuses an unknown output contract and any field beyond the catalog’s', () => {
    const [first] = catalog().agents;
    for (const changed of [
      { ...first, output: 'code' },
      { ...first, prompt: 'You are a writer.' },
      { ...first, tools: ['write_file'] },
      { ...first, resourceHash: 'f'.repeat(64) },
    ])
      expect(TeamCatalog.safeParse({ ...catalog(), agents: [changed] }).success).toBe(false);
    expect(
      TeamCatalog.safeParse({
        ...catalog(),
        skills: [{ ...skill('s1'), entry: 'skills/a/SKILL.md' }],
      }).success,
    ).toBe(false);
    expect(TeamCatalog.safeParse({ ...catalog(), teams: [] }).success).toBe(false);
  });
});

describe('TeamComposition', () => {
  it('accepts the three step kinds, rounds, added skills and every outrider', () => {
    accepts(composition());
    accepts(composition({ seats: [seat('only')], flow: [{ seat: 'only' }] }));
    accepts(
      composition({
        seats: [seat('scope'), seat('a'), seat('b'), seat('w1'), seat('w2'), seat('w3'), seat('j')],
        flow: [
          { seat: 'scope' },
          { parallel: ['a', 'b'] },
          { loop: { work: ['w1', 'w2', 'w3'], judge: 'j', rounds: 3 } },
        ],
      }),
    );
    // A loop may come first, and parallel may be the last step.
    accepts(
      composition({
        seats: [seat('w'), seat('j'), seat('a'), seat('b')],
        flow: [{ loop: { work: ['w'], judge: 'j', rounds: 1 } }, { parallel: ['a', 'b'] }],
      }),
    );
    accepts(
      composition({
        seats: [seat('plan', { skills: ['s1', 's2', 's3', 's4'] }), seat('write'), seat('check')],
      }),
    );
    for (const outrider of ['consultation', 'artifact_review', 'required_review'])
      accepts(composition({ outrider }));
  });

  it('keeps the text limits of the spec', () => {
    const text = (n: number) => 'x'.repeat(n);
    accepts(composition({ name: text(80), brief: text(2000), criteria: [text(200)] }));
    rejects(composition({ name: text(81) }));
    rejects(composition({ name: '  ' }));
    rejects(composition({ brief: text(2001) }));
    rejects(composition({ brief: '' }));
    rejects(composition({ criteria: [text(201)] }));
    rejects(composition({ criteria: [''] }));
    accepts(
      composition({
        seats: [seat('plan', { name: text(40), duty: text(400) }), seat('write'), seat('check')],
      }),
    );
    rejects(
      composition({ seats: [seat('plan', { name: text(41) }), seat('write'), seat('check')] }),
    );
    rejects(
      composition({ seats: [seat('plan', { duty: text(401) }), seat('write'), seat('check')] }),
    );
    rejects(composition({ seats: [seat('plan', { duty: '' }), seat('write'), seat('check')] }));
  });

  it('holds 1 to 6 criteria', () => {
    accepts(composition({ criteria: Array.from({ length: 6 }, (_, i) => `c${i}`) }));
    rejects(composition({ criteria: [] }));
    rejects(composition({ criteria: Array.from({ length: 7 }, (_, i) => `c${i}`) }));
  });

  it('holds 1 to 8 seats', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
    accepts(
      composition({
        seats: ids(8).map((id) => seat(id)),
        flow: ids(8).map((id) => ({ seat: id })),
      }),
    );
    rejects(
      composition({
        seats: ids(9).map((id) => seat(id)),
        flow: ids(9).map((id) => ({ seat: id })),
      }),
    );
    rejects(composition({ seats: [], flow: [] }));
  });

  it('adds up to four distinct skills to a seat', () => {
    const withSkills = (skills: string[]) =>
      composition({ seats: [seat('plan', { skills }), seat('write'), seat('check')] });
    accepts(withSkills([]));
    rejects(withSkills(['s1', 's2', 's3', 's4', 's5']));
    rejects(withSkills(['s1', 's1']));
  });

  it('holds 2 to 4 seats side by side, 1 to 3 working seats and 1 to 3 rounds in a loop', () => {
    const seats = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => seat(id));
    const flowOf = (step: unknown, rest: string[]) => [...rest.map((id) => ({ seat: id })), step];
    accepts(
      composition({
        seats: seats.slice(0, 5),
        flow: flowOf({ parallel: ['b', 'c', 'd', 'e'] }, ['a']),
      }),
    );
    rejects(composition({ seats: seats.slice(0, 2), flow: flowOf({ parallel: ['b'] }, ['a']) }));
    rejects(composition({ seats, flow: flowOf({ parallel: ['b', 'c', 'd', 'e', 'f'] }, ['a']) }));
    rejects(composition({ seats: seats.slice(0, 1), flow: [{ loop: { work: [], judge: 'a' } }] }));
    rejects(
      composition({
        seats: seats.slice(0, 5),
        flow: [{ loop: { work: ['a', 'b', 'c', 'd'], judge: 'e' } }],
      }),
    );
    for (const rounds of [0, 4, 1.5])
      rejects(
        composition({
          seats: seats.slice(0, 2),
          flow: [{ loop: { work: ['a'], judge: 'b', rounds } }],
        }),
      );
  });

  it('refuses a flow with no step', () => {
    rejects(composition({ flow: [] }));
  });

  it('refuses a seat id used twice', () => {
    rejects(composition({ seats: [seat('plan'), seat('plan'), seat('write'), seat('check')] }));
  });

  it('refuses a step that names a seat that does not exist', () => {
    rejects(
      composition({ flow: [{ seat: 'plan' }, { loop: { work: ['write'], judge: 'nobody' } }] }),
    );
    rejects(
      composition({
        flow: [{ seat: 'plan' }, { loop: { work: ['ghost'], judge: 'check' } }, { seat: 'write' }],
      }),
    );
    rejects(
      composition({
        flow: [{ seat: 'plan' }, { parallel: ['write', 'ghost'] }, { seat: 'check' }],
      }),
    );
  });

  it('refuses a seat that the flow leaves out', () => {
    rejects(composition({ flow: [{ seat: 'plan' }, { seat: 'write' }] }));
  });

  it('refuses a seat that the flow names twice, in any position', () => {
    rejects(
      composition({
        flow: [{ seat: 'plan' }, { seat: 'plan' }, { loop: { work: ['write'], judge: 'check' } }],
      }),
    );
    rejects(
      composition({
        flow: [{ seat: 'plan' }, { loop: { work: ['write', 'check'], judge: 'check' } }],
      }),
    );
    rejects(
      composition({
        flow: [{ seat: 'plan' }, { parallel: ['write', 'write'] }, { seat: 'check' }],
      }),
    );
    rejects(
      composition({
        flow: [
          { seat: 'plan' },
          { parallel: ['write', 'check'] },
          { loop: { work: ['write'], judge: 'check' } },
        ],
      }),
    );
  });

  it('refuses parallel as the first step', () => {
    rejects(composition({ flow: [{ parallel: ['plan', 'write'] }, { seat: 'check' }] }));
  });

  it('refuses any field beyond the shape: no tools, no observation, no approval', () => {
    rejects(
      composition({
        seats: [seat('plan', { tools: ['write_file'] }), seat('write'), seat('check')],
      }),
    );
    rejects(
      composition({
        seats: [seat('plan', { modelProfile: 'model-b' }), seat('write'), seat('check')],
      }),
    );
    rejects(composition({ observeWork: true }));
    rejects(composition({ finalApproval: true }));
    rejects(composition({ pattern: 'single' }));
    rejects(composition({ outrider: 'clarify_review' }));
    rejects(composition({ flow: [{ seat: 'plan', parallel: ['write', 'check'] }] }));
    rejects(
      composition({
        flow: [{ seat: 'plan' }, { loop: { work: ['write'], judge: 'check', limit: 'ask' } }],
      }),
    );
    rejects(composition({ flow: [{ seat: 'plan' }, { join: ['write', 'check'] }] }));
  });
});
