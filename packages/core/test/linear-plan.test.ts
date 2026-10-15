import { CorralDefinition } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { planLinearRun } from '../src/index.ts';

describe('planLinearRun (P0 runner until LangGraph in C-014)', () => {
  it('[TC-CAN-001-N] follows the drawn control edges, so rewiring changes the order', () => {
    const drawn = planLinearRun(linearCorral(['research', 'writer']));
    const rewired = planLinearRun(linearCorral(['writer', 'research']));
    expect(drawn).toEqual({
      ok: true,
      agentNodeIds: ['research', 'writer'],
      outputNodeId: 'output',
    });
    expect(rewired).toEqual({
      ok: true,
      agentNodeIds: ['writer', 'research'],
      outputNodeId: 'output',
    });
  });

  it('rejects node kinds this runner cannot execute yet, naming the node', () => {
    const plan = planLinearRun(CorralDefinition.parse(researchTeam));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ code: 'GRAPH_INVALID', nodeId: 'review_loop' }),
    );
  });

  it('rejects a scheduled agent that the control flow never reaches', () => {
    const definition = linearCorral(['research', 'writer']);
    definition.controlEdges = [
      { id: 'e1', source: 'research', sourcePort: 'out', target: 'output', targetPort: 'in' },
    ];
    const plan = planLinearRun(definition);
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
    const plan = planLinearRun(definition);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.issues).toContainEqual(expect.objectContaining({ edgeId: 'e2' }));
  });

  it('rejects an entry node that is not a scheduled agent', () => {
    const definition = linearCorral(['research']);
    definition.entryNodeId = 'output';
    expect(planLinearRun(definition).ok).toBe(false);
  });
});
