import {
  type AgentRole,
  type CorralDefinition,
  type CorralNode,
  DEFAULT_LIMITS,
  CorralDefinition as Definition,
  type RunEvent,
  TeamCatalog,
  TeamComposition,
  type TeamPlan,
} from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENTS,
  BUILTIN_SKILLS,
  type ComposableAgent,
  type ComposableSkill,
  Coordinator,
  compileDefinition,
  compositionProblem,
  draftFromComposition,
  draftFromPlan,
  InProcessTransport,
  planRun,
  ROLE_PRESET_IDS,
  type RolePresetId,
  type RunProjection,
  roleFromPreset,
  TeamCompositionError,
  teamCatalog,
  waitForProjection,
} from '../src/index.ts';

// A team the model composes from the catalog becomes a definition (docs/specs/features/
// team-assistant.md, "팀 구성 제안", "조립"): every usable composition compiles strictly with no
// diagnostic, each role is a copy of its chosen agent, and the flow's three step kinds become the
// graph.

const PROFILES = { knownModelProfiles: ['model-a', 'model-b'] };
const labels = {
  loop: 'Review loop',
  decision: 'Review decision',
  join: 'Gather',
  output: 'Output',
};

// ── the catalog the editor would pass ──────────────────────────────────────────

const builtin = (id: RolePresetId): ComposableAgent => {
  const { id: _id, ...role } = roleFromPreset(id, id, `${id} agent`);
  return {
    role,
    origin: { kind: 'preset', presetId: id },
    description: `The ${id} does its part.`,
    builtin: true,
  };
};
const SENTINEL_PROMPT = 'SENTINEL-PROMPT: you are the project’s own release checker.';
const LIBRARY_HASH = 'a'.repeat(64);
const library: ComposableAgent = {
  role: {
    name: 'Release checker',
    prompt: SENTINEL_PROMPT,
    modelProfile: 'model-a',
    allowedWorkTools: ['search', 'read_document', 'read_file', 'write_artifact'],
    allowedCollaborationTools: ['read_artifact', 'submit_result'],
    outputContract: 'notes',
    editingMode: 'hashline',
    mcpTools: [{ serverId: 'docs', name: 'mcp__docs__lookup' }],
    skills: [{ resourceHash: LIBRARY_HASH, entry: 'skills/release-notes/SKILL.md' }],
  },
  origin: { kind: 'library', agentId: 'release_checker', revision: 3 },
};
const libraryReviewer: ComposableAgent = {
  role: {
    name: 'House reviewer',
    prompt: 'Review against the house rules.',
    modelProfile: 'model-a',
    allowedWorkTools: ['read_file', 'write_artifact'],
    allowedCollaborationTools: ['read_artifact', 'submit_result'],
    outputContract: 'review',
  },
  origin: { kind: 'library', agentId: 'house_reviewer', revision: 1 },
};
const builtinSkills: ComposableSkill[] = BUILTIN_SKILLS.map((skill) => ({
  ref: { resourceHash: skill.resourceHash, entry: skill.entry },
  name: skill.name,
  description: skill.description,
}));
const librarySkill: ComposableSkill = {
  ref: { resourceHash: LIBRARY_HASH, entry: 'skills/release-notes/SKILL.md' },
  name: 'release-notes',
  description: 'Writes release notes in the house style.',
};

const AGENTS = [...ROLE_PRESET_IDS.map(builtin), library, libraryReviewer];
const SKILLS = [...builtinSkills, librarySkill];
const resolved = teamCatalog(AGENTS, SKILLS);
const { catalog } = resolved;

/** The catalog id of an agent by its name. */
const agentId = (name: string) => {
  const found = catalog.agents.find((agent) => agent.name === name);
  if (!found) throw new Error(`no catalog agent ${name}`);
  return found.id;
};
const skillId = (name: string) => {
  const found = catalog.skills.find((skill) => skill.name === name);
  if (!found) throw new Error(`no catalog skill ${name}`);
  return found.id;
};
const agentOf = (name: string) => {
  const found = AGENTS.find((agent) => agent.role.name === name);
  if (!found) throw new Error(`no agent ${name}`);
  return found;
};

// ── compositions ─────────────────────────────────────────────────────────────

type Seat = TeamComposition['seats'][number];
type Step = TeamComposition['flow'][number];

/** A seat named after its id, sitting the named agent. */
const seat = (id: string, agentName: string, more: Partial<Seat> = {}): Seat => ({
  id,
  agent: agentId(agentName),
  name: id,
  duty: `Do the ${id} part.`,
  ...more,
});
const compose = (seats: Seat[], flow: Step[], more: Partial<TeamComposition> = {}) =>
  TeamComposition.parse({
    name: 'Composed team',
    brief: 'Ship the change.',
    criteria: ['Do what the brief asks.', 'Say how it was checked.'],
    seats,
    flow,
    ...more,
  });
const draft = (composition: TeamComposition, corralId = 'composed_1') =>
  draftFromComposition(composition, corralId, resolved, labels);

function strict(definition: CorralDefinition) {
  expect(Definition.parse(definition)).toEqual(definition);
  const compiled = compileDefinition(definition, PROFILES);
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.ok).toBe(true);
  expect(planRun(definition).ok).toBe(true);
  return definition;
}

// ── reading a definition ─────────────────────────────────────────────────────

const nodeNamed = (definition: CorralDefinition, label: string) => {
  const node = definition.nodes.find((n) => n.type === 'agent' && n.label === label);
  if (node?.type !== 'agent' || node.invocation !== 'scheduled')
    throw new Error(`no seat ${label}`);
  return node;
};
const labelOf = (definition: CorralDefinition, id: string | undefined) =>
  definition.nodes.find((n) => n.id === id)?.label ?? `?${id}`;
/** Each input as the seat's name it reads, `prev:` a seat's previous round, or the run input. */
const inputsOf = (definition: CorralDefinition, label: string) =>
  nodeNamed(definition, label).inputBindings.map((b) =>
    b.kind === 'run_input'
      ? b.name
      : b.kind === 'previous_iteration_output'
        ? `prev:${labelOf(definition, b.sourceNodeId)}`
        : labelOf(definition, b.sourceNodeId),
  );
const outputOf = (definition: CorralDefinition) => {
  const output = definition.nodes.find((n) => n.type === 'output');
  if (output?.type !== 'output') throw new Error('no Output');
  return output;
};
const resultsOf = (definition: CorralDefinition) =>
  outputOf(definition).inputBindings.map((b) => labelOf(definition, b.sourceNodeId));
const roleOf = (definition: CorralDefinition, label: string) => {
  const node = nodeNamed(definition, label);
  const role = definition.roles.find((r) => r.id === node.roleId);
  if (!role) throw new Error(`no role for ${label}`);
  return role;
};
/** Edges as `source.port -> target.port`, by label. */
const edgesOf = (definition: CorralDefinition) =>
  definition.controlEdges.map(
    (e) =>
      `${labelOf(definition, e.source)}.${e.sourcePort} -> ${labelOf(definition, e.target)}.${e.targetPort}`,
  );
const ofType = <T extends CorralNode['type']>(definition: CorralDefinition, type: T) =>
  definition.nodes.filter((n): n is Extract<CorralNode, { type: T }> => n.type === type);

// ── the catalog ──────────────────────────────────────────────────────────────

describe('teamCatalog', () => {
  it('lists the agents and skills under short ids, in the order given', () => {
    expect(TeamCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog.agents.map((a) => a.id)).toEqual(AGENTS.map((_, i) => `a${i + 1}`));
    expect(catalog.skills.map((s) => s.id)).toEqual(SKILLS.map((_, i) => `s${i + 1}`));
    expect(catalog.agents.map((a) => a.name)).toEqual(AGENTS.map((a) => a.role.name));
    for (const [i, agent] of AGENTS.entries())
      expect(resolved.agentById.get(`a${i + 1}`)).toBe(agent);
    for (const [i, skill] of SKILLS.entries())
      expect(resolved.skillById.get(`s${i + 1}`)).toBe(skill);
  });

  it('describes each agent by what it changes, runs and returns, and the skills it has', () => {
    for (const preset of BUILTIN_AGENTS) {
      const entry = catalog.agents.find((a) => a.name === `${preset.id} agent`);
      expect(entry).toEqual({
        id: expect.any(String),
        name: `${preset.id} agent`,
        description: `The ${preset.id} does its part.`,
        changesFiles: preset.workTools.some((t) =>
          ['write_file', 'delete_file', 'move_file'].includes(t),
        ),
        runsCommands: preset.workTools.some((t) => ['run_command', 'preview_action'].includes(t)),
        output: preset.outputContract,
        skills: preset.skills.map((s) => s.name),
      });
    }
    expect(catalog.agents.find((a) => a.name === 'builder agent')).toMatchObject({
      changesFiles: true,
      runsCommands: true,
    });
    expect(catalog.agents.find((a) => a.name === 'reviewer agent')).toMatchObject({
      changesFiles: false,
      runsCommands: false,
      output: 'review',
    });
    // A saved agent has no description: only its name and the other fields go.
    expect(catalog.agents.find((a) => a.name === 'Release checker')).toEqual({
      id: agentId('Release checker'),
      name: 'Release checker',
      changesFiles: false,
      runsCommands: false,
      output: 'notes',
      skills: ['release-notes'],
    });
  });

  it('sends no prompt body, tool name, hash or path', () => {
    const text = JSON.stringify(catalog);
    expect(text).not.toContain('SENTINEL-PROMPT');
    expect(text).not.toContain(LIBRARY_HASH);
    expect(text).not.toContain('SKILL.md');
    for (const tool of [
      'write_file',
      'run_command',
      'read_artifact',
      'mcp__docs__lookup',
      'hashline',
    ])
      expect(text).not.toContain(tool);
    for (const skill of BUILTIN_SKILLS) {
      expect(text).not.toContain(skill.resourceHash);
      expect(text).not.toContain(skill.entry);
    }
    for (const agent of BUILTIN_AGENTS) expect(text).not.toContain(agent.prompt.slice(0, 60));
  });

  it('cuts a skill description to 300 characters and sends an empty one empty', () => {
    const { catalog: cut } = teamCatalog(
      [builtin('writer')],
      [
        { ...librarySkill, description: 'x'.repeat(301) },
        { ...librarySkill, name: 'plain', description: '' },
      ],
    );
    expect(cut.skills.map((s) => s.description)).toEqual(['x'.repeat(300), '']);
    expect(TeamCatalog.parse(cut)).toEqual(cut);
  });

  it('carries at most 64 agents and 256 skills', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      ...library,
      role: { ...library.role, name: `Agent ${i}` },
    }));
    const skills = Array.from({ length: 260 }, (_, i) => ({ ...librarySkill, name: `skill-${i}` }));
    const big = teamCatalog(many, skills);
    expect(big.catalog.agents).toHaveLength(64);
    expect(big.catalog.skills).toHaveLength(256);
    expect(big.catalog.agents.at(-1)?.name).toBe('Agent 63');
    expect(big.agentById.size).toBe(64);
    expect(big.skillById.size).toBe(256);
    expect(TeamCatalog.parse(big.catalog)).toEqual(big.catalog);
  });

  it('leaves out an advisor role, which no seat may take', () => {
    const advisor: ComposableAgent = {
      ...library,
      role: {
        ...library.role,
        name: 'Advisor',
        allowedCollaborationTools: ['advise', 'read_artifact'],
      },
    };
    const { catalog: listed } = teamCatalog([advisor, builtin('writer')], []);
    expect(listed.agents.map((a) => a.name)).toEqual(['writer agent']);
  });
});

// ── unusable compositions ────────────────────────────────────────────────────

describe('compositionProblem', () => {
  const usable = () =>
    compose(
      [seat('write', 'writer agent'), seat('check', 'reviewer agent')],
      [{ loop: { work: ['write'], judge: 'check' } }],
    );

  it('finds none in a usable composition', () => {
    expect(compositionProblem(usable(), catalog)).toBe(null);
    expect(compositionProblem(usable(), catalog, { reviewPolicy: 'required' })).toBe(null);
    const single = compose([seat('write', 'writer agent')], [{ seat: 'write' }]);
    expect(compositionProblem(single, catalog, { reviewPolicy: 'opinion_only' })).toBe(null);
  });

  it('refuses an agent the catalog does not list', () => {
    const composition = usable();
    composition.seats[0] = { ...seat('write', 'writer agent'), agent: 'a99' };
    expect(compositionProblem(composition, catalog)).toBe('unknown_agent');
    expect(() => draft(composition)).toThrow(TeamCompositionError);
  });

  it('refuses a skill the catalog does not list', () => {
    const composition = usable();
    composition.seats[0] = seat('write', 'writer agent', {
      skills: [skillId('release-notes'), 's999'],
    });
    expect(compositionProblem(composition, catalog)).toBe('unknown_skill');
    expect(() => draft(composition)).toThrow(/unknown_skill/);
  });

  it('refuses a loop whose judge does not return a review', () => {
    // The judge agent returns a draft; only the review contract can pass or send back work.
    for (const judge of ['judge agent', 'writer agent', 'Release checker']) {
      const composition = compose(
        [seat('write', 'writer agent'), seat('check', judge)],
        [{ loop: { work: ['write'], judge: 'check' } }],
      );
      expect(compositionProblem(composition, catalog)).toBe('judge_without_review');
      expect(() => draft(composition)).toThrow(/judge_without_review/);
    }
    const library = compose(
      [seat('write', 'writer agent'), seat('check', 'House reviewer')],
      [{ loop: { work: ['write'], judge: 'check' } }],
    );
    expect(compositionProblem(library, catalog)).toBe(null);
  });

  it('refuses a loop when the person chose opinions when needed', () => {
    expect(compositionProblem(usable(), catalog, { reviewPolicy: 'opinion_only' })).toBe(
      'loop_with_opinion_only',
    );
  });
});

// ── assembly ─────────────────────────────────────────────────────────────────

describe('draftFromComposition', () => {
  it('a single seat: its agent, its duty, the brief and criteria, and the Output', () => {
    const definition = strict(
      draft(compose([seat('write', 'writer agent', { name: 'Writer' })], [{ seat: 'write' }])),
    );
    expect(definition).toMatchObject({
      schemaVersion: '0.1',
      id: 'composed_1',
      name: 'Composed team',
      input: {
        brief: 'Ship the change.',
        criteria: ['Do what the brief asks.', 'Say how it was checked.'],
      },
      capabilityLinks: [],
      limits: DEFAULT_LIMITS,
    });
    expect(definition).not.toHaveProperty('sharedOutrider');
    expect(nodeNamed(definition, 'Writer')).toMatchObject({
      stepInstruction: 'Do the write part.',
      invocation: 'scheduled',
    });
    expect(definition.entryNodeId).toBe(nodeNamed(definition, 'Writer').id);
    // The last step gets the criteria too.
    expect(inputsOf(definition, 'Writer')).toEqual(['brief', 'criteria']);
    expect(resultsOf(definition)).toEqual(['Writer']);
    expect(outputOf(definition)).toMatchObject({ label: 'Output', requireApproval: false });
    expect(edgesOf(definition)).toEqual(['Writer.out -> Output.in']);
  });

  it('three seats in order: each reads the brief and every earlier seat', () => {
    const definition = strict(
      draft(
        compose(
          [
            seat('plan', 'architect agent'),
            seat('research', 'researcher agent'),
            seat('write', 'writer agent'),
          ],
          [{ seat: 'plan' }, { seat: 'research' }, { seat: 'write' }],
        ),
      ),
    );
    expect(inputsOf(definition, 'plan')).toEqual(['brief']);
    expect(inputsOf(definition, 'research')).toEqual(['brief', 'plan']);
    expect(inputsOf(definition, 'write')).toEqual(['brief', 'plan', 'research', 'criteria']);
    expect(edgesOf(definition)).toEqual([
      'plan.out -> research.in',
      'research.out -> write.in',
      'write.out -> Output.in',
    ]);
    expect(resultsOf(definition)).toEqual(['write']);
  });

  it('names the nodes from the flow, never from the model’s seat ids', () => {
    const definition = strict(
      draft(
        compose(
          [
            seat('output', 'architect agent'),
            seat('loop_1', 'writer agent'),
            seat('join_1', 'reviewer agent'),
            seat('a', 'researcher agent'),
            seat('b', 'explainer agent'),
          ],
          [
            { seat: 'output' },
            { loop: { work: ['loop_1'], judge: 'join_1' } },
            { parallel: ['a', 'b'] },
          ],
        ),
      ),
    );
    expect(definition.nodes.map((n) => n.id)).toEqual([
      'seat_1',
      'loop_1',
      'seat_2',
      'seat_3',
      'decision_1',
      'join_1',
      'seat_4',
      'seat_5',
      'join_2',
      'output',
    ]);
    expect(definition.roles.map((r) => r.id)).toEqual([
      'seat_1',
      'seat_2',
      'seat_3',
      'seat_4',
      'seat_5',
    ]);
    // An input is named after the seat it reads, as the model named it.
    expect(nodeNamed(definition, 'a').inputBindings.map((b) => b.name)).toEqual([
      'brief',
      'output',
      'loop_1',
      'join_1',
      'criteria',
    ]);
    expect(new Set(definition.controlEdges.map((e) => e.id)).size).toBe(
      definition.controlEdges.length,
    );
  });

  describe('loops', () => {
    const loopFirst = () =>
      compose(
        [seat('write', 'writer agent'), seat('check', 'reviewer agent')],
        [{ loop: { work: ['write'], judge: 'check' } }],
      );

    it('a loop as the first step: the Loop is the entry and the judge’s review decides', () => {
      const definition = strict(draft(loopFirst()));
      const [loop] = ofType(definition, 'loop');
      const [decision] = ofType(definition, 'decision');
      expect(definition.entryNodeId).toBe(loop?.id);
      expect(loop).toMatchObject({ label: 'Review loop', maxIterations: 2 });
      expect(loop).not.toHaveProperty('limitPolicy');
      expect(decision).toMatchObject({
        label: 'Review decision',
        parentId: loop?.id,
        mode: 'review',
        rule: 'review_verdict',
      });
      expect(decision?.inputBindings.map((b) => labelOf(definition, b.sourceNodeId))).toEqual([
        'check',
      ]);
      expect(nodeNamed(definition, 'write').parentId).toBe(loop?.id);
      expect(nodeNamed(definition, 'check').parentId).toBe(loop?.id);
      expect(edgesOf(definition)).toEqual([
        'Review loop.body -> write.in',
        'write.out -> check.in',
        'check.out -> Review decision.in',
        'Review decision.revise -> Review loop.repeat',
        'Review decision.pass -> Review loop.exit',
        'Review loop.next -> Output.in',
        'Review loop.exhausted -> Output.in',
      ]);
      // The work reads its last round and the last review; the judge reads the work, the
      // criteria and the brief; as the last step the work also gets the criteria.
      expect(inputsOf(definition, 'write')).toEqual([
        'brief',
        'prev:write',
        'prev:check',
        'criteria',
      ]);
      expect(
        nodeNamed(definition, 'write').inputBindings.filter(
          (b) => b.kind === 'previous_iteration_output',
        ),
      ).toEqual([
        expect.objectContaining({ optional: true }),
        expect.objectContaining({ optional: true }),
      ]);
      expect(inputsOf(definition, 'check')).toEqual(['brief', 'write', 'criteria']);
      // The team's result is the work's, not the review.
      expect(resultsOf(definition)).toEqual(['write']);
    });

    it.each([
      [1, 1],
      [3, 3],
      [undefined, 2],
    ] as const)('rounds %s is a Loop of %i iterations', (rounds, iterations) => {
      const composition = loopFirst();
      composition.flow = [
        { loop: { work: ['write'], judge: 'check', ...(rounds ? { rounds } : {}) } },
      ];
      const [loop] = ofType(strict(draft(composition)), 'loop');
      expect(loop?.maxIterations).toBe(iterations);
    });

    it('a loop in the middle: entered from the step before, and both exits go on to the next', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('plan', 'architect agent'),
              seat('build', 'builder agent'),
              seat('verify', 'verifier agent'),
              seat('explain', 'writer agent'),
            ],
            [{ seat: 'plan' }, { loop: { work: ['build'], judge: 'verify' } }, { seat: 'explain' }],
          ),
        ),
      );
      expect(edgesOf(definition)).toEqual([
        'plan.out -> Review loop.enter',
        'Review loop.body -> build.in',
        'build.out -> verify.in',
        'verify.out -> Review decision.in',
        'Review decision.revise -> Review loop.repeat',
        'Review decision.pass -> Review loop.exit',
        'Review loop.next -> explain.in',
        'Review loop.exhausted -> explain.in',
        'explain.out -> Output.in',
      ]);
      expect(inputsOf(definition, 'build')).toEqual(['brief', 'plan', 'prev:build', 'prev:verify']);
      expect(inputsOf(definition, 'verify')).toEqual(['brief', 'plan', 'build', 'criteria']);
      // After the loop: every seat of the loop, work and judge.
      expect(inputsOf(definition, 'explain')).toEqual([
        'brief',
        'plan',
        'build',
        'verify',
        'criteria',
      ]);
      expect(resultsOf(definition)).toEqual(['explain']);
    });

    it('exhausted goes where next goes, after every loop', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('w1', 'writer agent'),
              seat('j1', 'reviewer agent'),
              seat('w2', 'builder agent'),
              seat('j2', 'verifier agent'),
              seat('a', 'researcher agent'),
              seat('b', 'explainer agent'),
            ],
            [
              { loop: { work: ['w1'], judge: 'j1' } },
              { loop: { work: ['w2'], judge: 'j2' } },
              { parallel: ['a', 'b'] },
            ],
          ),
        ),
      );
      for (const loop of ofType(definition, 'loop')) {
        const from = (port: string) =>
          definition.controlEdges
            .filter((e) => e.source === loop.id && e.sourcePort === port)
            .map((e) => `${e.target}.${e.targetPort}`);
        expect(from('next')).toHaveLength(1);
        expect(from('exhausted')).toEqual(from('next'));
      }
    });

    it('two loops in one flow have their own Loop, decision and wiring', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('w1', 'writer agent'),
              seat('j1', 'reviewer agent'),
              seat('w2', 'builder agent'),
              seat('j2', 'verifier agent'),
            ],
            [
              { loop: { work: ['w1'], judge: 'j1' } },
              { loop: { work: ['w2'], judge: 'j2', rounds: 3 } },
            ],
          ),
        ),
      );
      const loops = ofType(definition, 'loop');
      const decisions = ofType(definition, 'decision');
      expect(loops.map((l) => l.maxIterations)).toEqual([2, 3]);
      expect(new Set(loops.map((l) => l.id)).size).toBe(2);
      expect(decisions.map((d) => d.parentId)).toEqual(loops.map((l) => l.id));
      expect(decisions.map((d) => labelOf(definition, d.inputBindings[0]?.sourceNodeId))).toEqual([
        'j1',
        'j2',
      ]);
      expect(nodeNamed(definition, 'w2').parentId).toBe(loops[1]?.id);
      const [first, second] = loops;
      expect(
        definition.controlEdges.filter((e) => e.source === first?.id && e.sourcePort !== 'body'),
      ).toEqual([
        expect.objectContaining({ sourcePort: 'next', target: second?.id, targetPort: 'enter' }),
        expect.objectContaining({
          sourcePort: 'exhausted',
          target: second?.id,
          targetPort: 'enter',
        }),
      ]);
      expect(inputsOf(definition, 'w2')).toEqual([
        'brief',
        'w1',
        'j1',
        'prev:w2',
        'prev:j2',
        'criteria',
      ]);
      expect(inputsOf(definition, 'j2')).toEqual(['brief', 'w1', 'j1', 'w2', 'criteria']);
      expect(resultsOf(definition)).toEqual(['w2']);
    });

    it('three working seats: each reads the round’s earlier work; the judge reads all of it', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('scope', 'architect agent'),
              seat('draft', 'writer agent'),
              seat('build', 'builder agent'),
              seat('polish', 'writer agent'),
              seat('check', 'reviewer agent'),
            ],
            [{ seat: 'scope' }, { loop: { work: ['draft', 'build', 'polish'], judge: 'check' } }],
          ),
        ),
      );
      expect(edgesOf(definition)).toEqual([
        'scope.out -> Review loop.enter',
        'Review loop.body -> draft.in',
        'draft.out -> build.in',
        'build.out -> polish.in',
        'polish.out -> check.in',
        'check.out -> Review decision.in',
        'Review decision.revise -> Review loop.repeat',
        'Review decision.pass -> Review loop.exit',
        'Review loop.next -> Output.in',
        'Review loop.exhausted -> Output.in',
      ]);
      expect(inputsOf(definition, 'draft')).toEqual([
        'brief',
        'scope',
        'prev:draft',
        'prev:check',
        'criteria',
      ]);
      expect(inputsOf(definition, 'build')).toEqual([
        'brief',
        'scope',
        'draft',
        'prev:build',
        'prev:check',
        'criteria',
      ]);
      expect(inputsOf(definition, 'polish')).toEqual([
        'brief',
        'scope',
        'draft',
        'build',
        'prev:polish',
        'prev:check',
        'criteria',
      ]);
      expect(inputsOf(definition, 'check')).toEqual([
        'brief',
        'scope',
        'draft',
        'build',
        'polish',
        'criteria',
      ]);
      // The loop's result is its last working seat's.
      expect(resultsOf(definition)).toEqual(['polish']);
    });
  });

  describe('side by side', () => {
    it('a group in the middle fans out from the step before and meets at a Join', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('scope', 'explainer agent'),
              seat('a', 'adversary agent'),
              seat('b', 'adversary agent'),
              seat('c', 'investigator agent'),
              seat('verdict', 'writer agent'),
            ],
            [{ seat: 'scope' }, { parallel: ['a', 'b', 'c'] }, { seat: 'verdict' }],
          ),
        ),
      );
      const [join] = ofType(definition, 'join');
      expect(join).toMatchObject({ label: 'Gather', policy: 'all' });
      expect(edgesOf(definition)).toEqual([
        'scope.out -> a.in',
        'scope.out -> b.in',
        'scope.out -> c.in',
        'a.out -> Gather.in',
        'b.out -> Gather.in',
        'c.out -> Gather.in',
        'Gather.out -> verdict.in',
        'verdict.out -> Output.in',
      ]);
      // Seats side by side do not read each other.
      for (const id of ['a', 'b', 'c'])
        expect(inputsOf(definition, id)).toEqual(['brief', 'scope']);
      expect(inputsOf(definition, 'verdict')).toEqual([
        'brief',
        'scope',
        'a',
        'b',
        'c',
        'criteria',
      ]);
    });

    it('a group as the last step: the team receives each seat’s result under its own name', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('frame', 'architect agent'),
              seat('option_a', 'researcher agent'),
              seat('option_b', 'researcher agent'),
            ],
            [{ seat: 'frame' }, { parallel: ['option_a', 'option_b'] }],
          ),
        ),
      );
      expect(edgesOf(definition)).toEqual([
        'frame.out -> option_a.in',
        'frame.out -> option_b.in',
        'option_a.out -> Gather.in',
        'option_b.out -> Gather.in',
        'Gather.out -> Output.in',
      ]);
      expect(resultsOf(definition)).toEqual(['option_a', 'option_b']);
      const names = outputOf(definition).inputBindings.map((b) => b.name);
      expect(names).toEqual(['option_a', 'option_b']);
      expect(
        outputOf(definition).inputBindings.every((b) => b.kind === 'task_output' && !b.optional),
      ).toBe(true);
      for (const id of ['option_a', 'option_b'])
        expect(inputsOf(definition, id)).toEqual(['brief', 'frame', 'criteria']);
    });

    it('a group followed by a loop: the Join enters the Loop', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('scope', 'architect agent'),
              seat('a', 'researcher agent'),
              seat('b', 'investigator agent'),
              seat('write', 'writer agent'),
              seat('check', 'reviewer agent'),
            ],
            [
              { seat: 'scope' },
              { parallel: ['a', 'b'] },
              { loop: { work: ['write'], judge: 'check' } },
            ],
          ),
        ),
      );
      expect(edgesOf(definition)).toContain('Gather.out -> Review loop.enter');
      expect(inputsOf(definition, 'write')).toEqual([
        'brief',
        'scope',
        'a',
        'b',
        'prev:write',
        'prev:check',
        'criteria',
      ]);
      expect(inputsOf(definition, 'check')).toEqual([
        'brief',
        'scope',
        'a',
        'b',
        'write',
        'criteria',
      ]);
    });

    it('a loop followed by a group: both ways out of the Loop pass one any-Join, then fan out', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('write', 'writer agent'),
              seat('check', 'reviewer agent'),
              seat('a', 'researcher agent'),
              seat('b', 'explainer agent'),
            ],
            [{ loop: { work: ['write'], judge: 'check' } }, { parallel: ['a', 'b'] }],
          ),
        ),
      );
      const joins = ofType(definition, 'join');
      expect(joins.map((j) => j.policy)).toEqual(['any', 'all']);
      expect(edgesOf(definition).slice(5)).toEqual([
        'Review loop.next -> Gather.in',
        'Review loop.exhausted -> Gather.in',
        'Gather.out -> a.in',
        'Gather.out -> b.in',
        'a.out -> Gather.in',
        'b.out -> Gather.in',
        'Gather.out -> Output.in',
      ]);
      expect(
        definition.controlEdges.filter((e) => e.target === joins[0]?.id).map((e) => e.source),
      ).toEqual([ofType(definition, 'loop')[0]?.id, ofType(definition, 'loop')[0]?.id]);
      for (const id of ['a', 'b'])
        expect(inputsOf(definition, id)).toEqual(['brief', 'write', 'check', 'criteria']);
      expect(resultsOf(definition)).toEqual(['a', 'b']);
    });

    it('two groups: the first Join fans out to the second group', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('scope', 'architect agent'),
              seat('a', 'researcher agent'),
              seat('b', 'investigator agent'),
              seat('c', 'adversary agent'),
              seat('d', 'explainer agent'),
            ],
            [{ seat: 'scope' }, { parallel: ['a', 'b'] }, { parallel: ['c', 'd'] }],
          ),
        ),
      );
      const joins = ofType(definition, 'join');
      expect(joins.map((j) => j.policy)).toEqual(['all', 'all']);
      expect(
        definition.controlEdges
          .filter((e) => e.source === joins[0]?.id)
          .map((e) => labelOf(definition, e.target)),
      ).toEqual(['c', 'd']);
      expect(
        definition.controlEdges
          .filter((e) => e.source === joins[1]?.id)
          .map((e) => labelOf(definition, e.target)),
      ).toEqual(['Output']);
      for (const id of ['c', 'd'])
        expect(inputsOf(definition, id)).toEqual(['brief', 'scope', 'a', 'b', 'criteria']);
      expect(resultsOf(definition)).toEqual(['c', 'd']);
    });

    it('an even seat of a group whose agent is built in takes the second model slot', () => {
      const definition = strict(
        draft(
          compose(
            [
              seat('scope', 'architect agent'),
              seat('p1', 'researcher agent'),
              seat('p2', 'researcher agent'),
              seat('p3', 'adversary agent'),
              seat('p4', 'Release checker'),
              seat('q1', 'explainer agent'),
              seat('q2', 'judge agent'),
            ],
            [{ seat: 'scope' }, { parallel: ['p1', 'p2', 'p3', 'p4'] }, { parallel: ['q1', 'q2'] }],
          ),
        ),
      );
      const profile = (label: string) => roleOf(definition, label).modelProfile;
      expect(['scope', 'p1', 'p2', 'p3', 'p4', 'q1', 'q2'].map(profile)).toEqual([
        'model-a',
        'model-a',
        'model-b',
        'model-a',
        // A saved agent keeps the slot it chose.
        'model-a',
        'model-a',
        'model-b',
      ]);
      // Outside a group every seat keeps its agent's slot, even a built-in one on model-b.
      const sequence = strict(
        draft(
          compose(
            [
              seat('one', 'researcher agent'),
              seat('two', 'researcher agent'),
              seat('three', 'judge agent'),
            ],
            [{ seat: 'one' }, { seat: 'two' }, { seat: 'three' }],
          ),
        ),
      );
      expect(sequence.roles.map((r) => r.modelProfile)).toEqual(['model-a', 'model-a', 'model-b']);
    });
  });

  describe('roles', () => {
    const mixed = () =>
      compose(
        [
          seat('scope', 'architect agent', { name: 'Scope' }),
          seat('check', 'Release checker', { name: 'Release check' }),
          seat('build', 'builder agent', { name: 'Build' }),
          seat('review', 'House reviewer', { name: 'Review' }),
        ],
        [{ seat: 'scope' }, { seat: 'check' }, { loop: { work: ['build'], judge: 'review' } }],
      );

    it('each role is a copy of its agent under the seat’s name, built-in or saved', () => {
      const definition = strict(draft(mixed()));
      for (const [label, agentName] of [
        ['Scope', 'architect agent'],
        ['Release check', 'Release checker'],
        ['Build', 'builder agent'],
        ['Review', 'House reviewer'],
      ] as const) {
        const agent = agentOf(agentName);
        const role = roleOf(definition, label);
        const { id, name, origin, ...settings } = role;
        expect(name).toBe(label);
        expect(origin).toEqual(agent.origin);
        expect({ ...settings, name: agent.role.name }).toEqual(agent.role);
        expect(role.allowedWorkTools).toEqual(agent.role.allowedWorkTools);
        expect(nodeNamed(definition, label).roleId).toBe(id);
      }
      // A saved agent's own settings come along whole.
      expect(roleOf(definition, 'Release check')).toMatchObject({
        prompt: SENTINEL_PROMPT,
        editingMode: 'hashline',
        mcpTools: [{ serverId: 'docs', name: 'mcp__docs__lookup' }],
        origin: { kind: 'library', agentId: 'release_checker', revision: 3 },
      });
      expect(nodeNamed(definition, 'Release check').stepInstruction).toBe('Do the check part.');
    });

    it('a role never shares a list with its agent or with another seat of the same agent', () => {
      const composition = compose(
        [seat('one', 'Release checker'), seat('two', 'Release checker')],
        [{ seat: 'one' }, { seat: 'two' }],
      );
      const definition = strict(draft(composition));
      expect(definition.roles).toHaveLength(2);
      const [one, two] = definition.roles as [AgentRole, AgentRole];
      one.allowedWorkTools.push('write_file');
      one.skills?.pop();
      one.mcpTools?.pop();
      expect(two.allowedWorkTools).not.toContain('write_file');
      expect(library.role.allowedWorkTools).not.toContain('write_file');
      expect(library.role.skills).toHaveLength(1);
      expect(library.role.mcpTools).toHaveLength(1);
    });

    it('the seat’s skills are added after the agent’s own, never twice', () => {
      const builder = agentOf('builder agent');
      const own = builder.role.skills ?? [];
      const ownName = BUILTIN_SKILLS.find(
        (s) => s.resourceHash === own[0]?.resourceHash && s.entry === own[0]?.entry,
      )?.name;
      if (!ownName) throw new Error('the builder has no built-in skill');
      const extra = BUILTIN_SKILLS.find(
        (s) => !own.some((r) => r.resourceHash === s.resourceHash && r.entry === s.entry),
      );
      if (!extra) throw new Error('no other built-in skill');
      const definition = strict(
        draft(
          compose(
            [
              seat('build', 'builder agent', {
                skills: [skillId(ownName), skillId(extra.name), skillId('release-notes')],
              }),
              // The saved agent already has release-notes.
              seat('check', 'Release checker', { skills: [skillId('release-notes')] }),
            ],
            [{ seat: 'build' }, { seat: 'check' }],
          ),
        ),
      );
      expect(roleOf(definition, 'build').skills).toEqual([
        ...own,
        { resourceHash: extra.resourceHash, entry: extra.entry },
        librarySkill.ref,
      ]);
      expect(roleOf(definition, 'check').skills).toEqual(library.role.skills);
    });

    it('a seat without skills keeps an agent that names none as it is', () => {
      const bare: ComposableAgent = { role: { ...libraryReviewer.role, name: 'Bare' } };
      const own = teamCatalog([bare, builtin('writer')], [librarySkill]);
      const composition = TeamComposition.parse({
        name: 'n',
        brief: 'b',
        criteria: ['c'],
        seats: [
          { id: 'one', agent: 'a1', name: 'One', duty: 'd' },
          { id: 'two', agent: 'a1', name: 'Two', duty: 'd', skills: ['s1'] },
        ],
        flow: [{ seat: 'one' }, { seat: 'two' }],
      });
      const definition = strict(draftFromComposition(composition, 'c', own, labels));
      expect(roleOf(definition, 'One')).not.toHaveProperty('skills');
      expect(roleOf(definition, 'One')).not.toHaveProperty('origin');
      expect(roleOf(definition, 'Two').skills).toEqual([librarySkill.ref]);
    });
  });

  it('a seat that returns a review gets the criteria wherever it sits', () => {
    const definition = strict(
      draft(
        compose(
          [
            seat('write', 'writer agent'),
            seat('critique', 'reviewer agent'),
            seat('a', 'verifier agent'),
            seat('b', 'researcher agent'),
            seat('fix', 'writer agent'),
          ],
          [{ seat: 'write' }, { seat: 'critique' }, { parallel: ['a', 'b'] }, { seat: 'fix' }],
        ),
      ),
    );
    expect(inputsOf(definition, 'critique')).toEqual(['brief', 'write', 'criteria']);
    expect(inputsOf(definition, 'a')).toEqual(['brief', 'write', 'critique', 'criteria']);
    expect(inputsOf(definition, 'b')).toEqual(['brief', 'write', 'critique']);
    expect(inputsOf(definition, 'write')).toEqual(['brief']);
  });

  it('two seats that change files side by side: the compiler warns, and nothing else', () => {
    // docs/specs/features/team-assistant.md promises no diagnostic for every usable composition;
    // the compiler warns PARALLEL_WRITERS here. Reported, not hidden.
    const definition = draft(
      compose(
        [seat('plan', 'architect agent'), seat('a', 'builder agent'), seat('b', 'builder agent')],
        [{ seat: 'plan' }, { parallel: ['a', 'b'] }],
      ),
    );
    expect(
      compileDefinition(definition, PROFILES).diagnostics.map((d) => [
        d.code,
        d.severity,
        labelOf(definition, d.nodeId),
      ]),
    ).toEqual([
      ['PARALLEL_WRITERS', 'warning', 'a'],
      ['PARALLEL_WRITERS', 'warning', 'b'],
    ]);
  });

  describe('the shared Outrider', () => {
    const plan = (outrider: TeamPlan['outrider']): TeamPlan => ({
      name: 'Plan',
      pattern: 'single',
      brief: 'Ship the change.',
      criteria: ['Do what the brief asks.'],
      roles: [{ slot: 'worker', name: 'Worker', duty: 'Work.' }],
      finalApproval: false,
      ...(outrider ? { outrider } : {}),
    });
    const single = (outrider?: TeamComposition['outrider']) =>
      compose([seat('write', 'writer agent')], [{ seat: 'write' }], outrider ? { outrider } : {});

    it.each(['consultation', 'artifact_review', 'required_review'] as const)(
      '%s is the same Outrider a drafted plan gets, with no observation',
      (outrider) => {
        const definition = strict(draft(single(outrider)));
        expect(definition.sharedOutrider).toEqual(
          draftFromPlan(plan(outrider), 'p').definition.sharedOutrider,
        );
        expect(definition.sharedOutrider).not.toHaveProperty('observation');
        // The required review itself is the editor's command once the person confirms the target.
        expect(outputOf(definition)).not.toHaveProperty('requiredReviews');
      },
    );

    it('takes the principles from the labels when given', () => {
      const definition = draftFromComposition(single('consultation'), 'c', resolved, {
        ...labels,
        outriderPrinciples: '근거를 확인합니다.',
      });
      expect(definition.sharedOutrider?.principles).toBe('근거를 확인합니다.');
    });

    it('is absent without a request', () => {
      expect(strict(draft(single()))).not.toHaveProperty('sharedOutrider');
    });
  });
});

// ── every flow of up to four steps ──────────────────────────────────────────

type Kind = 'seat' | 'parallel' | 'loop';
function* flows(steps: number, prefix: Kind[] = []): Generator<Kind[]> {
  if (prefix.length === steps) {
    yield prefix;
    return;
  }
  for (const kind of ['seat', 'parallel', 'loop'] as const)
    if (prefix.length || kind !== 'parallel') yield* flows(steps, [...prefix, kind]);
}
const ALL_FLOWS = [1, 2, 3, 4].flatMap((n) => [...flows(n)]);
const WORKERS = ROLE_PRESET_IDS.map((id) => `${id} agent`);
const JUDGES = ['reviewer agent', 'verifier agent', 'House reviewer'];

/** Seats and steps for a list of kinds; agents rotate over every built-in agent. */
function sweep(kinds: Kind[], { loopWork = 1, groupSize = 2 } = {}) {
  const seats: Seat[] = [];
  let worker = 0;
  let judge = 0;
  const next = () => {
    const id = `s${seats.length + 1}`;
    seats.push(seat(id, WORKERS[worker++ % WORKERS.length] as string));
    return id;
  };
  const flow = kinds.map((kind): Step => {
    if (kind === 'seat') return { seat: next() };
    if (kind === 'parallel') return { parallel: Array.from({ length: groupSize }, next) };
    const work = Array.from({ length: loopWork }, next);
    const id = `s${seats.length + 1}`;
    seats.push(seat(id, JUDGES[judge++ % JUDGES.length] as string));
    return { loop: { work, judge: id } };
  });
  return { seats, flow };
}

describe('every flow of up to four steps', () => {
  it('counts 80 flows, none starting side by side', () => {
    expect(ALL_FLOWS).toHaveLength(80);
    expect(ALL_FLOWS.some((kinds) => kinds[0] === 'parallel')).toBe(false);
  });

  it.each(ALL_FLOWS.map((kinds) => [kinds.join(' → '), kinds] as const))(
    '%s compiles strictly with no diagnostic',
    (_name, kinds) => {
      for (const sizes of [
        { loopWork: 1, groupSize: 2 },
        { loopWork: 2, groupSize: 3 },
      ]) {
        const { seats, flow } = sweep(kinds, sizes);
        if (seats.length > 8) continue;
        const composition = compose(seats, flow);
        expect(compositionProblem(composition, catalog)).toBe(null);
        const definition = strict(draft(composition));
        const agents = definition.nodes.filter((n) => n.type === 'agent');
        expect(agents).toHaveLength(seats.length);
        expect(ofType(definition, 'loop')).toHaveLength(kinds.filter((k) => k === 'loop').length);
        for (const s of seats)
          expect(roleOf(definition, s.id).allowedWorkTools).toEqual(
            resolved.agentById.get(s.agent)?.role.allowedWorkTools,
          );
      }
    },
  );
});

// ── mock runs ────────────────────────────────────────────────────────────────

function runtime(review?: () => string) {
  const clock = new FakeClock();
  return new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      agents: new ScriptedAgentAdapter({
        turns: 1,
        appendNotes: false,
        ...(review ? { review } : {}),
      }),
    }),
  );
}
let commands = 0;
async function run(definition: CorralDefinition, review?: () => string) {
  const transport = runtime(review);
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: `cmd_${++commands}`,
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
  const final = await waitForProjection(transport, runId, (p: RunProjection) =>
    ['succeeded', 'failed', 'cancelled'].includes(p.status),
  );
  return { final, events };
}
const ran = (p: RunProjection, nodeId: string) =>
  (p.nodeExecutions[nodeId] ?? []).map((id) => p.executions[id]?.status);

describe('mock runs of composed teams', () => {
  const loopThenGroup = () =>
    draft(
      compose(
        [
          seat('write', 'writer agent'),
          seat('check', 'reviewer agent'),
          seat('a', 'researcher agent'),
          seat('b', 'explainer agent'),
        ],
        [{ loop: { work: ['write'], judge: 'check' } }, { parallel: ['a', 'b'] }],
      ),
    );

  it.each([
    ['passes in round 2', undefined, ['revise', 'pass']],
    ['never passes', () => 'revise', ['revise', 'cap_reached']],
  ] as const)(
    'a loop that %s goes on to the group side by side and the team receives both results',
    async (_name, review, outcomes) => {
      const definition = loopThenGroup();
      const { final, events } = await run(definition, review);
      expect(final.status).toBe('succeeded');
      const [loop] = ofType(definition, 'loop');
      expect(
        (final.loopIterations[loop?.id ?? ''] ?? []).map((id) => final.iterations[id]?.outcome),
      ).toEqual(outcomes);
      for (const label of ['a', 'b'])
        expect(ran(final, nodeNamed(definition, label).id)).toEqual(['succeeded']);
      expect(Object.keys(final.approvals)).toEqual([]);
      const finalized = events.filter((e) => e.type === 'output.finalized');
      expect(finalized).toHaveLength(1);
      expect(
        finalized[0]?.type === 'output.finalized' && finalized[0].payload.artifactVersionIds,
      ).toHaveLength(2);
    },
  );

  it('a flow with every step kind runs to its Output', async () => {
    const definition = draft(
      compose(
        [
          seat('scope', 'architect agent'),
          seat('a', 'researcher agent'),
          seat('b', 'investigator agent'),
          seat('build', 'builder agent'),
          seat('verify', 'verifier agent'),
          seat('write', 'writer agent'),
        ],
        [
          { seat: 'scope' },
          { parallel: ['a', 'b'] },
          { loop: { work: ['build'], judge: 'verify' } },
          { seat: 'write' },
        ],
      ),
    );
    const { final, events } = await run(definition);
    expect(final.status).toBe('succeeded');
    expect(ran(final, nodeNamed(definition, 'write').id)).toEqual(['succeeded']);
    expect(events.filter((e) => e.type === 'output.finalized')).toHaveLength(1);
  });
});
