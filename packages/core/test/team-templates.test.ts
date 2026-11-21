import {
  AgentRole,
  type CorralDefinition,
  CorralDefinition as Definition,
  isWorkAgent,
  type RunEvent,
  type WorkTool,
} from '@corral/contracts';
import { FakeClock, Gate, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  autoDefinition,
  BUILTIN_AGENTS,
  BUILTIN_SKILLS,
  builtinSkillName,
  CHANGE_TOOLS,
  Coordinator,
  compileDefinition,
  InProcessTransport,
  isReadOnlyTeam,
  planRun,
  ROLE_PRESET_IDS,
  ROLE_PRESETS,
  ROLE_RULES,
  type RolePresetId,
  type RunProjection,
  roleFromPreset,
  TEAM_TEMPLATE_IDS,
  TEAM_TEMPLATE_ROLES,
  type TeamTemplateId,
  type TeamTemplateWording,
  teamTemplate,
  waitForProjection,
} from '../src/index.ts';

// The library's templates built from the built-in agents (docs/specs/features/library.md,
// docs/specs/features/builtin-crew.md).

const labels = {
  loop: 'Review loop',
  decision: 'Review decision',
  verifyLoop: 'Verification loop',
  verifyDecision: 'Verification decision',
  join: 'Gather',
  output: 'Output',
};

/** Wording the way the Studio passes it: every role named and given a duty. */
function wording<T extends TeamTemplateId>(id: T): TeamTemplateWording<T> {
  const roles = Object.fromEntries(
    Object.keys(TEAM_TEMPLATE_ROLES[id]).map((key) => [
      key,
      { name: `${key} name`, duty: `Do the ${key} part.` },
    ]),
  ) as TeamTemplateWording<T>['roles'];
  return {
    name: `${id} team`,
    brief: `A brief for ${id}.`,
    criteria: ['Do what the brief asks.', 'Say how it was checked.'],
    roles,
    labels,
  };
}

const build = (id: TeamTemplateId, corralId = `${id.replaceAll('-', '_')}_1`) =>
  teamTemplate(id, corralId, wording(id));

const FILE_CHANGES = ['write_file', 'delete_file', 'move_file'] as const;
const COMMANDS = ['run_command', 'preview_action'] as const;
const holding = (definition: CorralDefinition, tools: readonly WorkTool[]) =>
  definition.roles
    .filter((role) => role.allowedWorkTools.some((tool) => tools.includes(tool)))
    .map((role) => role.id);
const agentOf = (id: string) => {
  const agent = BUILTIN_AGENTS.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`no agent ${id}`);
  return agent;
};
const skillNames = (role: AgentRole) => (role.skills ?? []).map((ref) => builtinSkillName(ref));
const READ_NOTE =
  ' When the session has a working copy, read the files with the file tools before relying on them.';
const CHANGE_NOTE =
  ' Make the changes with the file tools, and say what you changed and how you checked it.';

describe('role presets', () => {
  it('are the ten built-in agents, in the order the spec lists them', () => {
    expect([...ROLE_PRESET_IDS]).toEqual([
      'architect',
      'builder',
      'investigator',
      'reviewer',
      'adversary',
      'verifier',
      'judge',
      'explainer',
      'researcher',
      'writer',
    ]);
    expect([...ROLE_PRESET_IDS].sort()).toEqual(BUILTIN_AGENTS.map((agent) => agent.id).sort());
    expect(Object.keys(ROLE_PRESETS)).toEqual([...ROLE_PRESET_IDS]);
  });

  it.each(ROLE_PRESET_IDS)(
    '%s takes its tools, output, model slot and skills from the agent',
    (id) => {
      const agent = agentOf(id);
      const role = roleFromPreset(id, `${id}_seat`, `${id} name`);
      expect(AgentRole.parse(role)).toEqual(role);
      expect(role).toMatchObject({
        id: `${id}_seat`,
        name: `${id} name`,
        allowedWorkTools: [...agent.workTools],
        allowedCollaborationTools: [...agent.collaborationTools],
        outputContract: agent.outputContract,
        modelProfile: agent.modelSlot === 'b' ? 'model-b' : 'model-a',
      });
      // The generated refs without their names: a role's skill is a hash and an entry.
      expect(role.skills).toEqual(
        agent.skills.map(({ resourceHash, entry }) => ({ resourceHash, entry })),
      );
      expect(role).not.toHaveProperty('origin');
      expect(role).not.toHaveProperty('harness');
    },
  );

  it.each(ROLE_PRESET_IDS)(
    '%s: the base instruction is the agent body, then the common rules',
    (id) => {
      const role = roleFromPreset(id, id, id);
      const writes = agentOf(id).workTools.includes('write_file');
      expect(role.prompt).toBe(
        `${agentOf(id).prompt}\n\n${ROLE_RULES}${READ_NOTE}${writes ? CHANGE_NOTE : ''}`,
      );
    },
  );

  it('tells only an agent that changes files to make its changes with the file tools', () => {
    // Running commands is not changing files: the investigator, adversary, verifier and
    // explainer run commands and leave the working copy alone.
    const told = ROLE_PRESET_IDS.filter((id) =>
      roleFromPreset(id, id, id).prompt.includes(CHANGE_NOTE),
    );
    expect(told).toEqual(['builder']);
    for (const id of ['investigator', 'adversary', 'verifier', 'explainer'] as const)
      expect(roleFromPreset(id, id, id).allowedWorkTools).toContain('run_command');
  });

  it('a seat adds a built-in skill by name and another model slot, and nothing else', () => {
    const plain = roleFromPreset('builder', 'pin', 'Pin');
    const pinned = roleFromPreset('builder', 'pin', 'Pin', { skills: ['behavior-pin'] });
    expect(skillNames(pinned)).toEqual([...skillNames(plain), 'behavior-pin']);
    // A skill the agent already names is not listed twice.
    expect(roleFromPreset('verifier', 'v', 'V', { skills: ['measure-first'] }).skills).toEqual(
      roleFromPreset('verifier', 'v', 'V').skills,
    );
    const second = roleFromPreset('adversary', 'attack_b', 'B', { modelProfile: 'model-b' });
    expect(second.modelProfile).toBe('model-b');
    expect({ ...second, modelProfile: 'model-a', id: 'x' }).toEqual({
      ...roleFromPreset('adversary', 'attack_b', 'B'),
      id: 'x',
    });
    expect(() => roleFromPreset('builder', 'x', 'X', { skills: ['no-such-skill'] })).toThrow(
      /no-such-skill/,
    );
  });

  it('a role made from a preset never shares its lists', () => {
    const role = roleFromPreset('reviewer', 'review', '검토');
    role.allowedWorkTools.push('write_file');
    role.skills?.pop();
    expect(ROLE_PRESETS.reviewer.allowedWorkTools).not.toContain('write_file');
    expect(roleFromPreset('reviewer', 'review', '검토').skills).toHaveLength(
      agentOf('reviewer').skills.length,
    );
  });

  it('names a built-in skill from its ref, and nothing else', () => {
    for (const skill of BUILTIN_SKILLS)
      expect(builtinSkillName({ resourceHash: skill.resourceHash, entry: skill.entry })).toBe(
        skill.name,
      );
    const [first] = BUILTIN_SKILLS;
    expect(builtinSkillName({ resourceHash: 'f'.repeat(64), entry: first?.entry ?? '' })).toBe(
      null,
    );
  });
});

describe('team templates', () => {
  it('are the eight built from the agents, in the library’s order', () => {
    expect([...TEAM_TEMPLATE_IDS]).toEqual([
      'implement-review',
      'feature',
      'bug-fix',
      'refactor',
      'performance',
      'adversarial-review',
      'tech-decision',
      'code-investigation',
    ]);
  });

  it('seat each role id with the agent library.md names', () => {
    expect(TEAM_TEMPLATE_ROLES).toEqual({
      'implement-review': { implement: 'builder', review: 'reviewer' },
      feature: { design: 'architect', implement: 'builder', verify: 'verifier' },
      'bug-fix': { investigate: 'investigator', fix: 'builder', verify: 'verifier' },
      refactor: { pin: 'builder', reshape: 'builder', verify: 'verifier' },
      performance: { baseline: 'investigator', improve: 'builder', measure: 'verifier' },
      'adversarial-review': {
        scope: 'explainer',
        attack_a: 'adversary',
        attack_b: 'adversary',
        verdict: 'judge',
      },
      'tech-decision': {
        frame: 'architect',
        option_a: 'researcher',
        option_b: 'researcher',
        decide: 'judge',
      },
      'code-investigation': {
        scope: 'explainer',
        trace: 'explainer',
        history: 'explainer',
        write: 'writer',
      },
    });
  });

  it.each(TEAM_TEMPLATE_IDS)('%s passes strict compile without a diagnostic', (id) => {
    const definition = build(id);
    expect(Definition.parse(definition)).toEqual(definition);
    const compiled = compileDefinition(definition, { knownModelProfiles: ['model-a', 'model-b'] });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.ok).toBe(true);
    expect(planRun(definition).ok).toBe(true);
  });

  // library.md: the seats that change files and the seats that run commands, per template.
  it.each([
    ['implement-review', ['implement'], ['implement']],
    ['feature', ['implement'], ['implement', 'verify']],
    ['bug-fix', ['fix'], ['investigate', 'fix', 'verify']],
    ['refactor', ['pin', 'reshape'], ['pin', 'reshape', 'verify']],
    ['performance', ['improve'], ['baseline', 'improve', 'measure']],
    ['adversarial-review', [], ['scope', 'attack_a', 'attack_b']],
    ['tech-decision', [], []],
    ['code-investigation', [], ['scope', 'trace', 'history']],
  ] as const)('%s: only %j change files and only %j run commands', (id, files, commands) => {
    const definition = build(id);
    expect(holding(definition, FILE_CHANGES)).toEqual([...files]);
    expect(holding(definition, COMMANDS)).toEqual([...commands]);
    for (const role of definition.roles) {
      for (const tool of FILE_CHANGES)
        expect([role.id, tool, role.allowedWorkTools.includes(tool)]).toEqual([
          role.id,
          tool,
          (files as readonly string[]).includes(role.id),
        ]);
      for (const tool of COMMANDS)
        expect([role.id, tool, role.allowedWorkTools.includes(tool)]).toEqual([
          role.id,
          tool,
          (commands as readonly string[]).includes(role.id),
        ]);
    }
    expect(isReadOnlyTeam(definition)).toBe(files.length + commands.length === 0);
  });

  it.each(TEAM_TEMPLATE_IDS)('%s takes each role from its agent', (id) => {
    const definition = build(id);
    const seats = TEAM_TEMPLATE_ROLES[id] as Record<string, RolePresetId>;
    expect(definition.roles.map((role) => role.id)).toEqual(Object.keys(seats));
    for (const role of definition.roles) {
      const agent = agentOf(seats[role.id] as string);
      expect(role.allowedWorkTools).toEqual([...agent.workTools]);
      expect(role.allowedCollaborationTools).toEqual([...agent.collaborationTools]);
      expect(role.outputContract).toBe(agent.outputContract);
      expect(role.prompt.startsWith(`${agent.prompt}\n\n${ROLE_RULES}`)).toBe(true);
      expect(role).not.toHaveProperty('origin');
      expect(role).not.toHaveProperty('harness');
    }
  });

  it.each(TEAM_TEMPLATE_IDS)('%s keeps each template duty on its seat', (id) => {
    const definition = build(id);
    const seats = definition.nodes.filter(isWorkAgent);
    expect(seats.map((node) => [node.roleId, node.stepInstruction])).toEqual(
      Object.keys(TEAM_TEMPLATE_ROLES[id]).map((slot) => [slot, `Do the ${slot} part.`]),
    );
    for (const role of definition.roles) expect(role.prompt).not.toContain(`${role.id} part`);
  });

  it('selects each agent’s skills, plus behavior-pin and measure-first where the seat needs them', () => {
    const extra: Record<string, string[]> = {
      'refactor/pin': ['behavior-pin'],
      'refactor/reshape': ['behavior-pin'],
      'performance/improve': ['measure-first'],
    };
    for (const id of TEAM_TEMPLATE_IDS) {
      const seats = TEAM_TEMPLATE_ROLES[id] as Record<string, RolePresetId>;
      for (const role of build(id).roles) {
        const agent = agentOf(seats[role.id] as string);
        expect([`${id}/${role.id}`, skillNames(role)]).toEqual([
          `${id}/${role.id}`,
          [...agent.skills.map((skill) => skill.name), ...(extra[`${id}/${role.id}`] ?? [])],
        ]);
      }
    }
  });

  it('puts the second of two side-by-side seats on the second model', () => {
    const models = (id: TeamTemplateId) =>
      Object.fromEntries(build(id).roles.map((role) => [role.id, role.modelProfile]));
    expect(models('adversarial-review')).toEqual({
      scope: 'model-a',
      attack_a: 'model-a',
      attack_b: 'model-b',
      verdict: 'model-b',
    });
    expect(models('tech-decision')).toEqual({
      frame: 'model-a',
      option_a: 'model-a',
      option_b: 'model-b',
      decide: 'model-b',
    });
    expect(models('code-investigation')).toEqual({
      scope: 'model-a',
      trace: 'model-a',
      history: 'model-b',
      write: 'model-a',
    });
  });

  it.each([
    ['implement-review', 'implement', 'review', 'Review loop', 'Review decision'],
    ['feature', 'implement', 'verify', 'Verification loop', 'Verification decision'],
    ['bug-fix', 'fix', 'verify', 'Verification loop', 'Verification decision'],
    ['refactor', 'reshape', 'verify', 'Verification loop', 'Verification decision'],
    ['performance', 'improve', 'measure', 'Verification loop', 'Verification decision'],
  ] as const)(
    '%s: the Loop around %s is judged by %s, at most two rounds',
    (id, worker, judge, loop, decision) => {
      const definition = build(id);
      const loops = definition.nodes.filter((node) => node.type === 'loop');
      expect(loops).toEqual([expect.objectContaining({ label: loop, maxIterations: 2 })]);
      const box = loops[0]?.id;
      const inside = definition.nodes
        .filter((node) => node.parentId === box)
        .map((node) => node.id);
      const decisionNode = definition.nodes.find((node) => node.type === 'decision');
      expect(inside).toEqual([worker, judge, decisionNode?.id]);
      expect(decisionNode).toMatchObject({
        label: decision,
        mode: 'review',
        rule: 'review_verdict',
        inputBindings: [{ kind: 'task_output', sourceNodeId: judge }],
      });
      // The worker revises from its own last round and the judge's last word.
      const workerNode = definition.nodes.find((node) => node.id === worker);
      expect(isWorkAgent(workerNode) && workerNode.inputBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'previous_iteration_output', sourceNodeId: worker }),
          expect.objectContaining({ kind: 'previous_iteration_output', sourceNodeId: judge }),
        ]),
      );
      const judgeNode = definition.nodes.find((node) => node.id === judge);
      expect(isWorkAgent(judgeNode) && judgeNode.inputBindings).toEqual(
        expect.arrayContaining([
          { kind: 'task_output', name: 'draft', sourceNodeId: worker },
          { kind: 'run_input', name: 'criteria' },
        ]),
      );
      // At the cap nobody is asked: `exhausted` goes where `next` goes.
      const from = (port: string) =>
        definition.controlEdges
          .filter((edge) => edge.source === box && edge.sourcePort === port)
          .map((edge) => edge.target);
      expect(from('exhausted')).toEqual(from('next'));
      expect(from('next')).toEqual(['output']);
    },
  );

  it('names the team, its roles, steps and inputs from the wording', () => {
    const definition = teamTemplate('bug-fix', 'bug_fix_1', {
      ...wording('bug-fix'),
      name: '버그 수정',
      brief: '설정 창이 닫힐 때 입력이 사라집니다.',
      criteria: ['원인을 근거와 함께 밝힙니다.'],
      roles: {
        investigate: { name: '원인 조사', duty: '원인을 찾습니다.' },
        fix: { name: '수정', duty: '원인을 고칩니다.' },
        verify: { name: '검증', duty: '수정을 확인합니다.' },
      },
      labels: {
        loop: '검토 루프',
        decision: '검토 판정',
        verifyLoop: '검증 루프',
        verifyDecision: '검증 판정',
        join: '모으기',
        output: '결과',
      },
    });
    expect(definition).toMatchObject({
      id: 'bug_fix_1',
      name: '버그 수정',
      input: {
        brief: '설정 창이 닫힐 때 입력이 사라집니다.',
        criteria: ['원인을 근거와 함께 밝힙니다.'],
      },
    });
    expect(definition.roles.map((role) => role.name)).toEqual(['원인 조사', '수정', '검증']);
    expect(definition.nodes.find((node) => node.id === 'fix')).toMatchObject({
      stepInstruction: '원인을 고칩니다.',
    });
    const labelsOf = Object.fromEntries(definition.nodes.map((node) => [node.type, node.label]));
    expect(labelsOf).toMatchObject({ loop: '검증 루프', decision: '검증 판정', output: '결과' });
    expect(
      definition.nodes.filter((node) => node.type === 'agent').map((node) => node.label),
    ).toEqual(['원인 조사', '수정', '검증']);
  });

  it('refuses wording that leaves a role unnamed', () => {
    const { roles, ...rest } = wording('adversarial-review');
    const { verdict: _, ...partial } = roles;
    expect(() =>
      teamTemplate('adversarial-review', 'p', { ...rest, roles: partial as typeof roles }),
    ).toThrow(/verdict/);
  });

  it('builds a new definition every time, so two copies share nothing', () => {
    const one = build('adversarial-review', 'one');
    const two = build('adversarial-review', 'two');
    expect(one.id).not.toBe(two.id);
    one.roles[0]?.allowedWorkTools.push('write_file');
    one.roles[0]?.skills?.pop();
    expect(two.roles[0]?.allowedWorkTools).not.toContain('write_file');
    expect(two.roles[0]?.skills).toHaveLength(agentOf('explainer').skills.length);
  });

  it('reads as read-only only when no role can change files or run commands', () => {
    const definition = build('implement-review');
    expect(isReadOnlyTeam(definition)).toBe(false);
    for (const tool of CHANGE_TOOLS) {
      const one: CorralDefinition = {
        ...build('tech-decision'),
        roles: build('tech-decision').roles.map((role, index) =>
          index === 0 ? { ...role, allowedWorkTools: [...role.allowedWorkTools, tool] } : role,
        ),
      };
      expect(isReadOnlyTeam(one)).toBe(false);
    }
    expect(isReadOnlyTeam({ ...definition, roles: [] })).toBe(false);
  });
});

// Mock runs: the scripted adapter answers every step; a review-contract seat in a Loop sends the
// work back in round 1 and passes after, unless the test scripts it otherwise.

function runtime(held: Record<string, Gate> = {}, review?: () => string) {
  const clock = new FakeClock();
  return new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      agents: new ScriptedAgentAdapter({
        turns: 1,
        appendNotes: false,
        beforeReply: async (_turn, input) => held[input.nodeId]?.wait(),
        ...(review ? { review } : {}),
      }),
    }),
  );
}

let commands = 0;
async function start(transport: InProcessTransport, definition: CorralDefinition) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: `cmd_${++commands}`,
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
  return { runId, events };
}

const finished = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const ran = (p: RunProjection, nodeId: string) =>
  (p.nodeExecutions[nodeId] ?? []).map((id) => p.executions[id]?.status);
const live = (p: RunProjection, nodeId: string) =>
  ran(p, nodeId).some((status) => !['succeeded', 'failed', 'cancelled'].includes(status ?? ''));
const rounds = (p: RunProjection, loopId: string) =>
  (p.loopIterations[loopId] ?? []).map((id) => p.iterations[id]?.outcome);
const finalized = (events: RunEvent[]) => events.filter((e) => e.type === 'output.finalized');
const loopOf = (definition: CorralDefinition) =>
  definition.nodes.find((node) => node.type === 'loop')?.id ?? '';

describe('mock runs of the templates', () => {
  // The browser demo has no harness resolver: roles that only select skills run without them.
  it('starts a template whose roles select skills, with no resolver and no pinned harness', async () => {
    const definition = build('feature');
    for (const role of definition.roles) {
      expect(role.skills?.length).toBeGreaterThan(0);
      expect(role).not.toHaveProperty('harness');
    }
    const transport = runtime();
    const { runId } = await start(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(ran(final, 'design')).toEqual(['succeeded']);
  });

  it('a saved team whose preset is no longer known still opens and runs', async () => {
    const definition = build('implement-review');
    const saved: CorralDefinition = {
      ...definition,
      roles: definition.roles.map((role) => ({
        ...role,
        origin: { kind: 'preset', presetId: role.id === 'review' ? 'review' : 'implement' },
      })),
    };
    expect(Definition.parse(saved)).toEqual(saved);
    expect(compileDefinition(saved).diagnostics).toEqual([]);
    const transport = runtime();
    const { runId } = await start(transport, saved);
    expect((await waitForProjection(transport, runId, finished)).status).toBe('succeeded');
  });

  it.each([
    ['implement-review', 'implement', 'review'],
    ['feature', 'implement', 'verify'],
    ['bug-fix', 'fix', 'verify'],
    ['refactor', 'reshape', 'verify'],
    ['performance', 'improve', 'measure'],
  ] as const)(
    '%s: %s is sent back once by %s, then passes, and the run reaches Output',
    async (id, worker, judge) => {
      const definition = build(id);
      const transport = runtime();
      const { runId, events } = await start(transport, definition);
      const final = await waitForProjection(transport, runId, finished);
      expect(final.status).toBe('succeeded');
      expect(rounds(final, loopOf(definition))).toEqual(['revise', 'pass']);
      expect(ran(final, worker)).toEqual(['succeeded', 'succeeded']);
      expect(ran(final, judge)).toEqual(['succeeded', 'succeeded']);
      expect(finalized(events)).toHaveLength(1);
    },
  );

  // docs/specs/features/library.md: a review Loop of a template, a draft or an auto team goes on
  // at its round cap to the step `next` leads to, without asking, with the last candidate.
  const auto = (template: 'write_review' | 'research_write_review') =>
    autoDefinition({
      id: `auto_${template}`,
      template,
      brief: 'Do the task.',
      choice: { modelProfile: 'model-a' },
      fileTools: false,
    });
  it.each([
    ['implement-review', () => build('implement-review'), 'implement', 'review'],
    ['feature', () => build('feature'), 'implement', 'verify'],
    ['bug-fix', () => build('bug-fix'), 'fix', 'verify'],
    ['refactor', () => build('refactor'), 'reshape', 'verify'],
    ['performance', () => build('performance'), 'improve', 'measure'],
    ['auto write_review', () => auto('write_review'), 'write', 'review'],
    ['auto research_write_review', () => auto('research_write_review'), 'write', 'review'],
  ] as const)(
    '%s: a judge that never passes ends with the last candidate, asking nobody',
    async (_name, definition, worker, judge) => {
      const team = definition();
      const transport = runtime({}, () => 'revise');
      const { runId, events } = await start(transport, team);
      const final = await waitForProjection(transport, runId, finished);
      expect(final.status).toBe('succeeded');
      expect(rounds(final, loopOf(team))).toEqual(['revise', 'cap_reached']);
      expect(Object.keys(final.approvals)).toEqual([]);
      expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
      // The last judgement stays with the result.
      expect(ran(final, judge)).toEqual(['succeeded', 'succeeded']);
      const last = final.nodeExecutions[worker]?.at(-1) ?? '';
      const candidate =
        final.tasks[final.executions[last]?.taskId ?? '']?.submittedArtifactVersionIds ?? [];
      const [output] = finalized(events);
      expect(output?.type === 'output.finalized' && output.payload.artifactVersionIds).toEqual(
        candidate,
      );
    },
  );

  it.each([
    ['adversarial-review', 'attack_a', 'attack_b', 'verdict'],
    ['tech-decision', 'option_a', 'option_b', 'decide'],
    ['code-investigation', 'trace', 'history', 'write'],
  ] as const)(
    '%s: %s and %s run at once and meet at the Join before %s',
    async (id, first, second, after) => {
      const one = new Gate();
      const two = new Gate();
      const transport = runtime({ [first]: one, [second]: two });
      const { runId, events } = await start(transport, build(id));
      const both = await waitForProjection(
        transport,
        runId,
        (p) => live(p, first) && live(p, second),
      );
      expect(ran(both, after)).toEqual([]);
      two.open();
      const half = await waitForProjection(transport, runId, (p) =>
        ran(p, second).every((status) => status === 'succeeded'),
      );
      expect(ran(half, after)).toEqual([]);
      one.open();
      const final = await waitForProjection(transport, runId, finished);
      expect(final.status).toBe('succeeded');
      expect(ran(final, after)).toEqual(['succeeded']);
      expect(events.flatMap((e) => (e.type === 'workflow.joined' ? [e.payload] : []))).toEqual([
        { nodeId: 'gather', policy: 'all', iterationId: null, cancelledNodeIds: [] },
      ]);
      expect(Object.values(final.approvals)).toEqual([]);
      expect(finalized(events)).toHaveLength(1);
    },
  );
});
