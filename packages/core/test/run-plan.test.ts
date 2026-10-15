import { CorralDefinition } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { planRun } from '../src/index.ts';

const orderOf = (definition: unknown) => {
  const result = planRun(definition);
  return result.ok ? result.plan.order : result.issues;
};

describe('planRun: what this runtime can execute', () => {
  it('[TC-CAN-001-N] follows the drawn control edges, so rewiring changes the order', () => {
    expect(orderOf(linearCorral(['research', 'writer']))).toEqual(['research', 'writer', 'output']);
    expect(orderOf(linearCorral(['writer', 'research']))).toEqual(['writer', 'research', 'output']);
  });

  it('refuses Decision steps until a decision policy exists, naming the node', () => {
    const plan = planRun(CorralDefinition.parse(researchTeam));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ code: 'COMMAND_NOT_SUPPORTED', nodeId: 'review_decision' }),
    );
    expect(plan.issues.some((i) => i.code === 'GRAPH_INVALID')).toBe(false);
  });

  it('accepts a Loop with Decisions when a policy is installed, but not a final approval yet', () => {
    const definition = CorralDefinition.parse(researchTeam);
    const withApproval = planRun(definition, { decisions: true });
    expect(withApproval.ok).toBe(false);
    if (!withApproval.ok) {
      expect(withApproval.issues.map((i) => i.nodeId)).toEqual(['output']);
    }
    const output = definition.nodes.find((n) => n.type === 'output');
    if (output?.type === 'output') output.requireApproval = false;
    expect(planRun(definition, { decisions: true }).ok).toBe(true);
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
