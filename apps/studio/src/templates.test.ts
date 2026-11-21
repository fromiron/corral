import { CorralDefinition, isWorkAgent } from '@corral/contracts';
import {
  BUILTIN_AGENTS,
  builtinSkillName,
  compileDefinition,
  createKeyValueCorralRepository,
  isReadOnlyTeam,
  planRun,
  type RoleWording,
  TEAM_TEMPLATE_ROLES,
} from '@corral/core';
import { emptyDraft } from '@corral/react';
import { assert, describe, expect, it } from 'vitest';
import en from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { templateForWorkspace } from './demo/templates.ts';
import {
  createFromTemplate,
  roleSteps,
  templateCopyName,
  templateDefinition,
  templateText,
  WORKSPACE_TEMPLATES,
  type WorkspaceTemplateId,
} from './templates.ts';

const english = templateText(en);
const korean = templateText(ko);

function memoryRepository() {
  const values = new Map<string, string>();
  let id = 0;
  return createKeyValueCorralRepository(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
    {
      newCorralId: () => `team_${++id}`,
      clock: { nowIso: () => '2026-11-11T00:00:00.000Z', monotonicMs: () => 0 },
    },
  );
}

describe('library templates (docs/specs/features/library.md)', () => {
  it('are the eleven the library shows, in its order', () => {
    expect([...WORKSPACE_TEMPLATES]).toEqual([
      'starter',
      'implement-review',
      'feature',
      'bug-fix',
      'refactor',
      'performance',
      'adversarial-review',
      'tech-decision',
      'code-investigation',
      'research-team',
      'blank',
    ]);
  });

  it('seeds an empty team in the screen language without example input', () => {
    const blank = templateDefinition('blank', 'corral_empty', korean);
    expect(blank.id).toBe('corral_empty');
    expect(blank.name).toBe(korean.blankName);
    expect(blank.input).toEqual({ brief: '', criteria: [] });
    expect(blank.nodes).toEqual([]);
  });

  // The empty canvas has no nodes, so it cannot be a runnable definition.
  const runnable = WORKSPACE_TEMPLATES.filter((id) => id !== 'blank');

  it.each(runnable)('%s passes strict compile in both languages', (id) => {
    for (const text of [english, korean]) {
      const definition = templateDefinition(id, `${id.replaceAll('-', '_')}_1`, text);
      expect(CorralDefinition.safeParse(definition).success).toBe(true);
      const compiled = compileDefinition(definition, {
        knownModelProfiles: ['model-a', 'model-b'],
      });
      expect(compiled.diagnostics).toEqual([]);
      expect(compiled.ok).toBe(true);
      expect(planRun(definition).ok).toBe(true);
    }
  });

  it.each(runnable)('%s keeps the localized seat duty separate from submission rules', (id) => {
    for (const text of [english, korean]) {
      const team = templateDefinition(id, 'copy', text);
      const words: Record<string, RoleWording> =
        id === 'starter' || id === 'research-team' ? text.demo(id).roles : text.wording(id).roles;
      const seats = team.nodes.filter(isWorkAgent);
      expect(seats.length).toBeGreaterThan(0);
      for (const seat of seats) {
        const duty = words[seat.roleId]?.duty;
        const role = team.roles.find((r) => r.id === seat.roleId);
        assert(duty && role);
        if (id === 'starter') {
          expect(seat).not.toHaveProperty('stepInstruction');
          expect(role.prompt).toBe(duty);
        } else {
          expect(seat.stepInstruction).toBe(duty);
          expect(role.prompt).toContain('submit with submit_result.');
          expect(role.prompt).not.toContain(duty);
        }
      }
    }
  });

  // library.md: which roles change files and which run commands, per template.
  it.each([
    ['starter', [], []],
    ['implement-review', ['implement'], ['implement']],
    ['feature', ['implement'], ['implement', 'verify']],
    ['bug-fix', ['fix'], ['investigate', 'fix', 'verify']],
    ['refactor', ['pin', 'reshape'], ['pin', 'reshape', 'verify']],
    ['performance', ['improve'], ['baseline', 'improve', 'measure']],
    ['adversarial-review', [], ['scope', 'attack_a', 'attack_b']],
    ['tech-decision', [], []],
    ['code-investigation', [], ['scope', 'trace', 'history']],
    ['research-team', [], []],
  ] as const)('%s lets only %j change files and only %j run commands', (id, files, commands) => {
    for (const text of [english, korean]) {
      const definition = templateDefinition(id, 'x', text);
      for (const role of definition.roles) {
        for (const tool of ['write_file', 'delete_file', 'move_file'] as const)
          expect([role.id, tool, role.allowedWorkTools.includes(tool)]).toEqual([
            role.id,
            tool,
            (files as readonly string[]).includes(role.id),
          ]);
        for (const tool of ['run_command', 'preview_action'] as const)
          expect([role.id, tool, role.allowedWorkTools.includes(tool)]).toEqual([
            role.id,
            tool,
            (commands as readonly string[]).includes(role.id),
          ]);
      }
      expect(isReadOnlyTeam(definition)).toBe(files.length + commands.length === 0);
    }
  });

  it('names a template, its roles and steps in the screen language', () => {
    const definition = templateDefinition('bug-fix', 'x', korean);
    expect(definition.name).toBe('버그 수정');
    expect(definition.roles.map((role) => role.name)).toEqual(['원인 조사', '수정', '검증']);
    expect(roleSteps(definition)).toEqual([['원인 조사'], ['수정'], ['검증']]);
    expect(templateDefinition('bug-fix', 'x', english).roles.map((r) => r.name)).toEqual([
      'Cause investigation',
      'Fix',
      'Verification',
    ]);
    // A Loop a verification judges reads as one in both languages.
    const labels = (team: CorralDefinition) =>
      team.nodes.filter((n) => n.type === 'loop' || n.type === 'decision').map((n) => n.label);
    expect(labels(definition)).toEqual(['검증 Loop', '검증 판정']);
    expect(labels(templateDefinition('performance', 'x', english))).toEqual([
      'Verification loop',
      'Verification decision',
    ]);
    expect(labels(templateDefinition('implement-review', 'x', korean))).toEqual([
      '검토 Loop',
      '검토 판정',
    ]);
  });

  it.each(WORKSPACE_TEMPLATES.filter((id) => id in TEAM_TEMPLATE_ROLES))(
    '%s seats each built-in agent with the skills it names, in both languages',
    (id) => {
      const seats = TEAM_TEMPLATE_ROLES[id as keyof typeof TEAM_TEMPLATE_ROLES] as Record<
        string,
        string
      >;
      // The skill a seat cannot do without, unless its agent already names it.
      const extra: Record<string, string[]> = {
        'refactor/pin': ['behavior-pin'],
        'refactor/reshape': ['behavior-pin'],
        'performance/improve': ['measure-first'],
      };
      for (const text of [english, korean]) {
        for (const role of templateDefinition(id, 'x', text).roles) {
          const agent = BUILTIN_AGENTS.find((candidate) => candidate.id === seats[role.id]);
          assert(agent, role.id);
          const named = agent.skills.map((skill) => skill.name);
          const added = (extra[`${id}/${role.id}`] ?? []).filter((name) => !named.includes(name));
          const names = (role.skills ?? []).map((ref) => builtinSkillName(ref));
          expect([`${id}/${role.id}`, names]).toEqual([`${id}/${role.id}`, [...named, ...added]]);
          expect(role).not.toHaveProperty('harness');
        }
      }
    },
  );

  it.each(['starter', 'research-team'] as const)(
    '%s, the demo’s template, selects no skills',
    (id) => {
      for (const text of [english, korean])
        for (const role of templateDefinition(id, 'x', text).roles)
          expect(role).not.toHaveProperty('skills');
    },
  );

  // The demo route keeps its English fixture; the workspace path writes these two in the
  // screen language with the same structure.
  it.each(['starter', 'research-team'] as const)(
    '%s in English is the demo fixture under the workspace name',
    (id) => {
      expect(templateDefinition(id, 'x', english)).toEqual(
        templateForWorkspace(id, 'x').definition,
      );
    },
  );

  it.each([
    ['starter', '단일 에이전트', [['에이전트 1']]],
    ['research-team', '조사 팀', [['조사자'], ['작성자'], ['검토자']]],
  ] as const)(
    '%s in Korean names its team, roles, nodes and sample brief in Korean',
    (id, name, steps) => {
      const definition = templateDefinition(id, 'x', korean);
      expect(definition.name).toBe(name);
      expect(roleSteps(definition)).toEqual(steps);
      const hangul = /[가-힣]/;
      const words = [
        ...definition.roles.map((role) => role.name),
        ...definition.nodes
          .filter(isWorkAgent)
          .map(
            (seat) =>
              seat.stepInstruction ??
              definition.roles.find((role) => role.id === seat.roleId)?.prompt,
          ),
        ...definition.nodes.map((node) => node.label),
        definition.input.brief,
        ...definition.input.criteria,
      ];
      expect(words.filter((word) => !word || !hangul.test(word))).toEqual([]);
      // Only the wording differs from the English team.
      const shape = (team: CorralDefinition) => ({
        ...team,
        name: '',
        input: { brief: '', criteria: team.input.criteria.map(() => '') },
        roles: team.roles.map((role) => ({ ...role, name: '', prompt: '' })),
        nodes: team.nodes.map((node) => ({ ...node, label: '', stepInstruction: undefined })),
      });
      expect(shape(definition)).toEqual(shape(templateDefinition(id, 'x', english)));
    },
  );

  it.each([
    ['starter', [['Agent 1']]],
    ['implement-review', [['Implementation'], ['Review']]],
    ['feature', [['Design'], ['Implementation'], ['Verification']]],
    ['bug-fix', [['Cause investigation'], ['Fix'], ['Verification']]],
    ['refactor', [['Behavior pin'], ['Restructuring'], ['Verification']]],
    ['performance', [['Baseline'], ['Improvement'], ['Re-measurement']]],
    ['adversarial-review', [['Scope'], ['Challenge A', 'Challenge B'], ['Verdict']]],
    ['tech-decision', [['Framing'], ['Option A research', 'Option B research'], ['Decision']]],
    ['code-investigation', [['Scope'], ['Trace', 'History'], ['Writing']]],
    ['research-team', [['Researcher'], ['Writer'], ['Reviewer']]],
    ['blank', []],
  ] as const)('%s lists its roles in execution order, at once ones together', (id, steps) => {
    expect(roleSteps(templateDefinition(id as WorkspaceTemplateId, 'x', english))).toEqual(steps);
  });

  it('saves the same template twice as two separate teams with their own ids and names', async () => {
    const repository = memoryRepository();
    const first = await createFromTemplate(repository, 'tech-decision', english, 'default');
    const second = await createFromTemplate(repository, 'tech-decision', english, 'default');
    if (!first.ok || !second.ok) throw new Error('expected both copies to save');
    expect(first.corralId).not.toBe(second.corralId);
    const one = await repository.get(first.corralId);
    const two = await repository.get(second.corralId);
    expect([one?.name, two?.name]).toEqual(['Technical decision', 'Technical decision (2)']);
    expect(one?.definition.id).toBe(first.corralId);
    expect(two?.definition.id).toBe(second.corralId);
    // The saved team compiles, and none of its roles may change files or run commands.
    for (const saved of [one, two]) {
      expect(compileDefinition(saved?.definition).ok).toBe(true);
      expect(isReadOnlyTeam(saved?.definition ?? { roles: [] })).toBe(true);
    }
  });
});

it('previews the same suffix sequence as save without considering teams from another project', () => {
  const teams = [
    { name: 'Research team', projectId: 'one' },
    { name: 'Research team (2)', projectId: 'one' },
    { name: 'Research team (3)', projectId: 'two' },
  ];
  expect(templateCopyName('Research team', 'one', teams)).toBe('Research team (3)');
  expect(templateCopyName('Research team', 'two', teams)).toBe('Research team');
  expect(templateCopyName('New name', 'one', teams)).toBe('New name');
});

it('names repeated template copies distinctly within their project', async () => {
  const values = new Map<string, string>();
  let id = 0;
  const repository = createKeyValueCorralRepository(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
    {
      newCorralId: () => `team_${++id}`,
      clock: { nowIso: () => '2026-10-28T00:00:00.000Z', monotonicMs: () => 0 },
    },
  );
  for (let copy = 0; copy < 3; copy++) {
    expect((await createFromTemplate(repository, 'research-team', english)).ok).toBe(true);
  }
  const names = (await repository.list()).map((team) => team.name);
  expect(new Set(names).size).toBe(3);
  expect(names).toEqual(
    expect.arrayContaining(['Research team', 'Research team (2)', 'Research team (3)']),
  );
});

it('new blank and template teams keep their definition revision on reload', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  let id = 0;
  const options = {
    newCorralId: () => `team_${++id}`,
    clock: { nowIso: () => '2026-10-28T00:00:00.000Z', monotonicMs: () => 0 },
  };
  const repository = createKeyValueCorralRepository(storage, options);
  const blank = emptyDraft();
  await repository.save({
    definition: blank.definition,
    expectedDefinitionRevision: null,
  });
  await createFromTemplate(repository, 'research-team', english);
  const before = await repository.list();
  const reloaded = createKeyValueCorralRepository(storage, options);
  expect(await reloaded.list()).toEqual(before);
});
