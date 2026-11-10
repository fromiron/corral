import type { CorralDefinition } from '@corral/contracts';
import { type DemoTemplate, demoTemplate, templateForWorkspace } from '../templates.ts';

// Test-only. The shipped research team asks for no approval; tests of approvals (the waiting
// conversation, Needs you, approve and reject, the final output confirmation) run this copy,
// which puts back a final approval Decision after the review Loop and an Output that requires
// approval, as a person would add them in the team editor. Unit tests and the E2E specs import
// it; nothing in the product does (templates.test.ts checks), so the bundle never carries it.

const APPROVAL: CorralDefinition['nodes'][number] = {
  id: 'approval',
  type: 'decision',
  label: 'Final approval',
  mode: 'approval',
  rule: 'human_approval',
  inputBindings: [{ kind: 'task_output', name: 'draft', sourceNodeId: 'write' }],
};

/** The research team with both approvals; with `id`, as a workspace copy of that id. */
export function approvalResearchTeam(id?: string): DemoTemplate {
  const template = id ? templateForWorkspace('research-team', id) : demoTemplate('research-team');
  const { definition } = template;
  const nodes = definition.nodes.flatMap((node) =>
    node.type === 'output' ? [APPROVAL, { ...node, requireApproval: true }] : [node],
  );
  const controlEdges = definition.controlEdges.flatMap((edge): CorralDefinition['controlEdges'] =>
    edge.source === 'review_loop' && edge.sourcePort === 'next'
      ? [
          { ...edge, target: 'approval' },
          {
            id: 'e8',
            source: 'approval',
            sourcePort: 'approve',
            target: 'output',
            targetPort: 'in',
          },
        ]
      : [edge],
  );
  return { ...template, definition: { ...definition, nodes, controlEdges } };
}
