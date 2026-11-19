import { CorralDefinition } from '@corral/contracts';
import { collaborationCorral, linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { compileDefinition, planRun, sharedOutriderTargets } from '../src/index.ts';

const orderOf = (definition: unknown) => {
  const result = planRun(definition);
  return result.ok ? result.plan.order : result.issues;
};

describe('planRun: what this runtime can execute', () => {
  it('follows the drawn control edges, so rewiring changes the order', () => {
    expect(orderOf(linearCorral(['research', 'writer']))).toEqual(['research', 'writer', 'output']);
    expect(orderOf(linearCorral(['writer', 'research']))).toEqual(['writer', 'research', 'output']);
  });

  it('plans the whole research team: Loop, Decisions and the final approval (P5)', () => {
    const plan = planRun(CorralDefinition.parse(researchTeam));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.order).toContain('review_decision');
    expect(plan.plan.order).toContain('approval');
  });

  it('rejects a scheduled agent that the control flow never reaches', () => {
    const definition = linearCorral(['research', 'writer']);
    definition.controlEdges = [
      { id: 'e1', source: 'research', sourcePort: 'out', target: 'output', targetPort: 'in' },
    ];
    const plan = planRun(definition);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.issues).toContainEqual(expect.objectContaining({ nodeId: 'writer' }));
  });

  it('rejects a cycle, naming the edge that closes it', () => {
    const definition = linearCorral(['research', 'writer']);
    definition.controlEdges = [
      { id: 'e1', source: 'research', sourcePort: 'out', target: 'writer', targetPort: 'in' },
      { id: 'e2', source: 'writer', sourcePort: 'out', target: 'research', targetPort: 'in' },
    ];
    const plan = planRun(definition);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.issues).toContainEqual(expect.objectContaining({ edgeId: 'e2' }));
  });

  it('rejects an entry node that is not a scheduled agent', () => {
    const definition = linearCorral(['research']);
    definition.entryNodeId = 'output';
    expect(planRun(definition).ok).toBe(false);
  });
});

describe('shared Outrider consultations', () => {
  const policy = {
    modelProfile: 'advisor-model',
    principles: 'Give a second opinion on the question.',
    targets: { kind: 'all' as const },
  };

  it('plans one read-only responder outside the flow, preserving manual links and the authored document', () => {
    const definition = { ...collaborationCorral(), sharedOutrider: policy };
    const before = JSON.stringify(definition);
    const result = planRun(definition);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [responder] = result.plan.callables.research!.question;
    expect(responder).toBeTruthy();
    expect(result.plan.callables.write!.question).toEqual(['respond', responder]);
    expect(result.plan.callables.helper!.question).toEqual([responder]);
    expect(result.plan.callables.respond!.question).toEqual([responder]);
    expect(result.plan.callables[responder!]).toBeUndefined();
    expect(result.plan.order).toEqual(['research', 'write', 'output']);
    expect(
      result.definition.roles.find((role) => role.modelProfile === policy.modelProfile),
    ).toMatchObject({
      prompt: policy.principles,
      allowedWorkTools: [],
      allowedCollaborationTools: expect.arrayContaining(['reply', 'read_artifact']),
    });
    expect(JSON.stringify(definition)).toBe(before);
    expect(result.sharedOutriderNodeIds).toEqual([responder]);
    expect(planRun(result.definition)).toMatchObject({
      ok: true,
      definition: result.definition,
      plan: result.plan,
    });
  });

  it('restricts effective questions to selected nodes, even when two workers share their role', () => {
    const definition = linearCorral(['planner', 'writer']);
    const writer = definition.nodes[1]!;
    if (writer.type === 'agent') writer.roleId = 'planner_role';
    const result = planRun({
      ...definition,
      sharedOutrider: { ...policy, targets: { kind: 'selected', nodeIds: ['planner'] } },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.plan.callables.planner!.question).toHaveLength(1);
    expect(result.plan.callables.writer?.question ?? []).toEqual([]);
    expect(definition.roles[0]!.allowedCollaborationTools).toEqual(['submit_result']);
  });

  it('shows depth and question limits in the roster and omits impossible questions', () => {
    const definition = { ...collaborationCorral(), sharedOutrider: policy };
    definition.limits = { ...definition.limits, maxDelegationDepth: 1 };
    expect(sharedOutriderTargets(definition)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'helper', unavailable: 'depth' }),
        expect.objectContaining({ nodeId: 'write', label: 'Writer' }),
      ]),
    );
    const result = planRun(definition);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.plan.callables.helper?.question ?? []).toEqual([]);
    definition.limits = { ...definition.limits, maxQuestions: 0 };
    expect(sharedOutriderTargets(definition).every((row) => row.unavailable === 'questions')).toBe(
      true,
    );
  });

  it('allows an empty selection, without a generated unreachable role', () => {
    const definition = linearCorral(['writer']);
    const result = planRun({
      ...definition,
      sharedOutrider: { ...policy, targets: { kind: 'selected', nodeIds: [] } },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.plan.callables).toEqual({});
    expect(result.definition.roles).toEqual(definition.roles);
  });

  it('accounts for a question spent reaching the worker, keeping workers reached by delegation eligible', () => {
    const definition = collaborationCorral();
    definition.limits = { ...definition.limits, maxQuestions: 1 };
    const rows = sharedOutriderTargets(definition);
    expect(rows.find((row) => row.nodeId === 'respond')?.unavailable).toBe('questions');
    expect(rows.find((row) => row.nodeId === 'helper')?.unavailable).toBeUndefined();
  });

  it('validates the consultation model with the same known profiles used for workers', () => {
    const definition = { ...linearCorral(['writer']), sharedOutrider: policy };
    const result = compileDefinition(definition, { knownModelProfiles: ['model-a'] });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_MODEL_PROFILE' }),
    );
    expect(planRun(definition, { knownModelProfiles: ['model-a'] }).ok).toBe(false);
  });

  it('explains pinned work-style restrictions and keeps unverified permissions distinct', () => {
    const definition = linearCorral(['planner', 'writer']);
    const harness = { profileId: 'restricted', revision: 2 };
    definition.roles[0]!.harness = harness;
    const unknown = sharedOutriderTargets(definition);
    expect(unknown[0]).toMatchObject({ nodeId: 'planner', harness, permissionPending: true });
    expect(unknown[1]).not.toHaveProperty('permissionPending');
    const blocked = sharedOutriderTargets(definition, undefined, () => false);
    expect(blocked[0]?.unavailable).toBe('harness');
    const allowed = sharedOutriderTargets(definition, undefined, (binding) =>
      binding.profileId === harness.profileId && binding.revision === harness.revision);
    expect(allowed[0]).not.toHaveProperty('unavailable');
    expect(allowed[0]).not.toHaveProperty('permissionPending');
  });
});
