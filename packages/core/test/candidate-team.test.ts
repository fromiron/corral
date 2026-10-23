import { UltraSelection } from '@corral/contracts';
import { expect, it } from 'vitest';
import { autoDefinition } from '../src/auto-team.ts';
import { candidateNumber } from '../src/candidate-team.ts';
import { compileDefinition, planRun } from '../src/index.ts';

const ultra = {
  version: 1 as const,
  modelProfiles: ['primary', 'verifier'],
  verifierProfile: 'verifier',
  reasoning: { primary: 'max' as const, verifier: 'high' as const },
};
const input = {
  id: 'candidate_team',
  template: 'write_review' as const,
  qualityPreset: 'ultra' as const,
  brief: 'Implement and check the change.',
  criteria: ['Preserve existing behavior.'],
  choice: { modelProfile: 'primary' },
  fileTools: true,
  commandTools: true,
  harness: { profileId: 'registered_checks', revision: 1 },
};

it('[TC-ULTRA-002-N] accepts an explicit bounded candidate model sequence and rejects models outside the selected pool', () => {
  const selection = {
    version: ultra.version,
    modelProfiles: ultra.modelProfiles,
    verifierProfile: ultra.verifierProfile,
  };
  expect(UltraSelection.safeParse(selection).success).toBe(true);
  expect(
    UltraSelection.safeParse({
      ...selection,
      comparison: { modelProfiles: ['primary', 'primary'] },
    }).success,
  ).toBe(true);
  for (const profiles of [[], ['primary'], Array(6).fill('primary'), ['primary', 'unselected']])
    expect(
      UltraSelection.safeParse({ ...selection, comparison: { modelProfiles: profiles } }).success,
    ).toBe(false);
});

it('[TC-ULTRA-002-H] builds five isolated review branches from the same plan with bounded tools and cross-model verification', () => {
  const comparison = { modelProfiles: ['primary', 'verifier', 'primary', 'primary', 'verifier'] };
  const definition = autoDefinition({ ...input, ultra: { ...ultra, comparison } });
  expect(definition.nodes.filter((node) => node.type === 'loop')).toHaveLength(5);
  expect(compileDefinition(definition)).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([
      {
        code: 'SCHEMA_INVALID',
        severity: 'error',
        message: 'this version supports at most 20 nodes per Corral',
      },
    ]),
  });
  expect(planRun(definition)).toMatchObject({ ok: false });
  expect(planRun(definition, { candidateComparison: true })).toMatchObject({ ok: true });
  expect(definition.input.criteria).toEqual(input.criteria);
  expect(definition.nodes.filter((node) => node.id === 'plan')).toHaveLength(1);
  expect(definition.nodes.filter((node) => node.type === 'output')).toHaveLength(1);
  expect(
    definition.nodes.some((node) => node.type === 'agent' && node.invocation === 'callable'),
  ).toBe(false);
  expect(definition.capabilityLinks).toEqual([]);
  for (const [index, profile] of comparison.modelProfiles.entries()) {
    const number = index + 1;
    expect(candidateNumber(`write_${number}`)).toBe(number);
    const writer = definition.roles.find((role) => role.id === `writer_${number}`)!;
    const reviewer = definition.roles.find((role) => role.id === `reviewer_${number}`)!;
    const synthesize = definition.nodes.find((node) => node.id === `synthesize_${number}`)!;
    const loop = definition.nodes.find((node) => node.id === `review_loop_${number}`)!;
    expect(writer.modelProfile).toBe(profile);
    expect(writer.reasoning).toEqual({
      mode: 'fixed',
      level: ultra.reasoning[profile as keyof typeof ultra.reasoning],
    });
    expect(reviewer.modelProfile).not.toBe(profile);
    expect(writer.allowedWorkTools).toEqual([
      'write_artifact',
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
      'move_file',
    ]);
    expect(writer.harness).toEqual(input.harness);
    expect(synthesize.type === 'agent' && synthesize.inputBindings).toContainEqual({
      kind: 'task_output',
      name: 'plan',
      sourceNodeId: 'plan',
    });
    expect(synthesize.type === 'agent' && synthesize.inputBindings).toContainEqual({
      kind: 'task_output',
      name: 'draft',
      sourceNodeId: `write_${number}`,
    });
    expect(loop.type === 'loop' && loop.reviewRecipe).toMatchObject({
      candidateNodeId: `synthesize_${number}`,
      preparationNodeId: `write_${number}`,
      evaluatorRoleId: `reviewer_${number}`,
    });
  }
  for (const role of definition.roles) {
    expect(role.allowedCollaborationTools).not.toContain('spawn_subagents');
    expect(role.allowedCollaborationTools).not.toContain('await_tasks');
    expect(role.allowedWorkTools).not.toContain('run_command');
    expect(role.allowedWorkTools).not.toContain('preview_app');
  }
  for (const id of ['plan', 'output', 'write_0', 'review_loop_6', 'specialist_1', 'write_01'])
    expect(candidateNumber(id)).toBeNull();
});

it('[TC-ULTRA-002-N] preserves the legacy collaboration recipe when comparison is omitted', () => {
  const definition = autoDefinition({ ...input, ultra });
  expect(definition.nodes.filter((node) => node.type === 'loop').map((node) => node.id)).toEqual([
    'review_loop',
  ]);
  expect(definition.roles.find((role) => role.id === 'writer')?.allowedWorkTools).toContain(
    'run_command',
  );
  expect(
    definition.roles.find((role) => role.id === 'planner')?.allowedCollaborationTools,
  ).toContain('spawn_subagents');
  expect(planRun(definition)).toMatchObject({ ok: true });
});
