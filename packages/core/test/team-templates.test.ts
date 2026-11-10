import {
  type CorralDefinition,
  CorralDefinition as Definition,
  type RunEvent,
} from '@corral/contracts';
import { FakeClock, Gate, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_TOOLS,
  Coordinator,
  compileDefinition,
  InProcessTransport,
  isReadOnlyTeam,
  planRun,
  ROLE_PRESET_IDS,
  ROLE_PRESETS,
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

// The library's templates built from role presets (docs/specs/features/library.md).

const labels = {
  loop: 'Review loop',
  decision: 'Review decision',
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

const changing = (definition: CorralDefinition) =>
  definition.roles
    .filter((role) => role.allowedWorkTools.some((tool) => CHANGE_TOOLS.includes(tool as never)))
    .map((role) => role.id)
    .sort();

describe('role presets', () => {
  it('are the eight the library names', () => {
    expect([...ROLE_PRESET_IDS]).toEqual([
      'implement',
      'plan',
      'review',
      'investigate',
      'correctness_review',
      'security_review',
      'research',
      'write',
    ]);
    expect(Object.keys(ROLE_PRESETS).sort()).toEqual([...ROLE_PRESET_IDS].sort());
  });

  it('give file and command tools to the implement preset alone', () => {
    const writers = ROLE_PRESET_IDS.filter((id) =>
      ROLE_PRESETS[id].allowedWorkTools.some((tool) => CHANGE_TOOLS.includes(tool as never)),
    );
    expect(writers).toEqual(['implement']);
    for (const tool of CHANGE_TOOLS)
      expect(ROLE_PRESETS.implement.allowedWorkTools).toContain(tool);
    // Every preset reads the working copy and writes its result as an artifact.
    for (const id of ROLE_PRESET_IDS) {
      expect(ROLE_PRESETS[id].allowedWorkTools).toEqual(
        expect.arrayContaining(['write_artifact', 'list_files', 'read_file']),
      );
      expect(ROLE_PRESETS[id].allowedCollaborationTools).toContain('submit_result');
    }
  });

  it('fix the output contract and model slot; reviews judge on the second model', () => {
    const contracts = Object.fromEntries(
      ROLE_PRESET_IDS.map((id) => [
        id,
        [ROLE_PRESETS[id].outputContract, ROLE_PRESETS[id].modelProfile],
      ]),
    );
    expect(contracts).toEqual({
      implement: ['draft', 'model-a'],
      plan: ['notes', 'model-a'],
      review: ['review', 'model-b'],
      investigate: ['notes', 'model-a'],
      correctness_review: ['review', 'model-b'],
      security_review: ['review', 'model-b'],
      research: ['notes', 'model-a'],
      write: ['draft', 'model-a'],
    });
  });

  it('become a role with the name and duty in the screen language', () => {
    const role = roleFromPreset('security_review', 'security', {
      name: '보안 검토',
      duty: '변경의 보안 문제를 찾습니다.',
    });
    expect(role).toMatchObject({
      id: 'security',
      name: '보안 검토',
      modelProfile: 'model-b',
      outputContract: 'review',
    });
    expect(role.prompt.startsWith('변경의 보안 문제를 찾습니다.')).toBe(true);
    // The table is data: a role made from it never shares its tool lists.
    role.allowedWorkTools.push('write_file');
    expect(ROLE_PRESETS.security_review.allowedWorkTools).not.toContain('write_file');
  });
});

describe('team templates', () => {
  it('are the five the library adds, in its order', () => {
    expect([...TEAM_TEMPLATE_IDS]).toEqual([
      'implement-review',
      'plan-implement-review',
      'bug-fix',
      'parallel-review',
      'tech-decision',
    ]);
  });

  it.each(TEAM_TEMPLATE_IDS)('%s passes strict compile without a diagnostic', (id) => {
    const definition = build(id);
    expect(Definition.parse(definition)).toEqual(definition);
    const compiled = compileDefinition(definition, { knownModelProfiles: ['model-a', 'model-b'] });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.ok).toBe(true);
    expect(planRun(definition).ok).toBe(true);
  });

  it.each([
    ['implement-review', ['implement']],
    ['plan-implement-review', ['implement']],
    ['bug-fix', ['fix']],
    ['parallel-review', []],
    ['tech-decision', []],
  ] as const)('%s gives the change tools only to %j', (id, roles) => {
    const definition = build(id);
    expect(changing(definition)).toEqual([...roles]);
    for (const role of definition.roles) {
      const changes = (roles as readonly string[]).includes(role.id);
      for (const tool of CHANGE_TOOLS) expect(role.allowedWorkTools.includes(tool)).toBe(changes);
    }
    expect(isReadOnlyTeam(definition)).toBe(roles.length === 0);
  });

  it.each(TEAM_TEMPLATE_IDS)('%s takes each role from its preset', (id) => {
    const definition = build(id);
    const presets = TEAM_TEMPLATE_ROLES[id] as Record<string, RolePresetId>;
    expect(definition.roles.map((role) => role.id)).toEqual(Object.keys(presets));
    for (const role of definition.roles) {
      const preset = ROLE_PRESETS[presets[role.id] as RolePresetId];
      expect(role.allowedWorkTools).toEqual([...preset.allowedWorkTools]);
      expect(role.allowedCollaborationTools).toEqual([...preset.allowedCollaborationTools]);
      expect(role.outputContract).toBe(preset.outputContract);
      expect(role.modelProfile).toBe(preset.modelProfile);
    }
  });

  it('names the team, its roles, steps and inputs from the wording', () => {
    const definition = teamTemplate('bug-fix', 'bug_fix_1', {
      ...wording('bug-fix'),
      name: '버그 수정',
      brief: '설정 창이 닫힐 때 입력이 사라집니다.',
      criteria: ['원인을 근거와 함께 밝힙니다.'],
      roles: {
        investigate: { name: '원인 조사', duty: '원인을 찾습니다.' },
        fix: { name: '수정', duty: '원인을 고칩니다.' },
        review: { name: '검토', duty: '수정을 검토합니다.' },
      },
      labels: { loop: '검토 루프', decision: '검토 판정', join: '모으기', output: '결과' },
    });
    expect(definition).toMatchObject({
      id: 'bug_fix_1',
      name: '버그 수정',
      input: {
        brief: '설정 창이 닫힐 때 입력이 사라집니다.',
        criteria: ['원인을 근거와 함께 밝힙니다.'],
      },
    });
    expect(definition.roles.map((role) => role.name)).toEqual(['원인 조사', '수정', '검토']);
    expect(definition.roles.find((role) => role.id === 'fix')?.prompt).toMatch(
      /^원인을 고칩니다\./,
    );
    const labelsOf = Object.fromEntries(definition.nodes.map((node) => [node.type, node.label]));
    expect(labelsOf).toMatchObject({ loop: '검토 루프', decision: '검토 판정', output: '결과' });
    expect(
      definition.nodes.filter((node) => node.type === 'agent').map((node) => node.label),
    ).toEqual(['원인 조사', '수정', '검토']);
  });

  it('refuses wording that leaves a role unnamed', () => {
    const { roles, ...rest } = wording('parallel-review');
    const { synthesis: _, ...partial } = roles;
    expect(() =>
      teamTemplate('parallel-review', 'p', { ...rest, roles: partial as typeof roles }),
    ).toThrow(/synthesis/);
  });

  it('builds a new definition every time, so two copies share nothing', () => {
    const one = build('parallel-review', 'one');
    const two = build('parallel-review', 'two');
    expect(one.id).not.toBe(two.id);
    one.roles[0]?.allowedWorkTools.push('write_file');
    expect(two.roles[0]?.allowedWorkTools).not.toContain('write_file');
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

// Mock runs: the scripted adapter answers every step; a reviewer in a Loop sends the work back
// in round 1 and passes after, unless the test scripts it otherwise.

function runtime(held: Record<string, Gate> = {}) {
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

describe('mock runs of the templates', () => {
  it.each([
    ['implement-review', 'implement'],
    ['plan-implement-review', 'implement'],
    ['bug-fix', 'fix'],
  ] as const)(
    '%s: the review sends %s back once, then passes, and the run reaches Output',
    async (id, worker) => {
      const transport = runtime();
      const { runId, events } = await start(transport, build(id));
      const final = await waitForProjection(transport, runId, finished);
      expect(final.status).toBe('succeeded');
      expect(rounds(final, 'review_loop')).toEqual(['revise', 'pass']);
      expect(ran(final, worker)).toEqual(['succeeded', 'succeeded']);
      expect(ran(final, 'review')).toEqual(['succeeded', 'succeeded']);
      expect(finalized(events)).toHaveLength(1);
    },
  );

  it('parallel-review: both reviews run at once and meet at the Join before the synthesis', async () => {
    const correctness = new Gate();
    const security = new Gate();
    const transport = runtime({ correctness, security });
    const { runId, events } = await start(transport, build('parallel-review'));
    const both = await waitForProjection(
      transport,
      runId,
      (p) => live(p, 'correctness') && live(p, 'security'),
    );
    expect(ran(both, 'synthesis')).toEqual([]);
    security.open();
    const half = await waitForProjection(transport, runId, (p) =>
      ran(p, 'security').every((status) => status === 'succeeded'),
    );
    expect(ran(half, 'synthesis')).toEqual([]);
    correctness.open();
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(ran(final, 'synthesis')).toEqual(['succeeded']);
    expect(events.flatMap((e) => (e.type === 'workflow.joined' ? [e.payload] : []))).toEqual([
      { nodeId: 'gather', policy: 'all', iterationId: null, cancelledNodeIds: [] },
    ]);
    expect(finalized(events)).toHaveLength(1);
  });

  it('tech-decision: both research branches meet, and the comparison is the result without an approval', async () => {
    const transport = runtime();
    const { runId, events } = await start(transport, build('tech-decision'));
    const final = await waitForProjection(
      transport,
      runId,
      (p) => p.status === 'awaiting_user' || finished(p),
    );
    expect(final.status).toBe('succeeded');
    expect(ran(final, 'research_a')).toEqual(['succeeded']);
    expect(ran(final, 'research_b')).toEqual(['succeeded']);
    expect(ran(final, 'compare')).toEqual(['succeeded']);
    expect(events.filter((e) => e.type === 'workflow.joined')).toHaveLength(1);
    expect(Object.values(final.approvals)).toEqual([]);
    expect(finalized(events)).toHaveLength(1);
  });
});
