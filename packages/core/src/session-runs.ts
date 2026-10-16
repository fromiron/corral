import { type CorralDefinition, DEFAULT_LIMITS } from '@corral/contracts';

// Runs a work session starts (CR-011). A follow-up uses the session's team with the person's
// words as the brief; a question about a result is a run of its own: one agent, no tools but
// writing its answer, on the model profile the team's first role uses.

const EXPLAIN_PROMPT = [
  'You answer a question about an earlier result of this work session.',
  'The result is in the brief. Explain from it; do not redo the work or invent new findings.',
  'If the result does not answer the question, say so plainly and say what is missing.',
].join(' ');

export function explainDefinition(input: {
  id: string;
  question: string;
  modelProfile: string;
}): CorralDefinition {
  return {
    schemaVersion: '0.1',
    id: input.id,
    name: 'Question about a result',
    entryNodeId: 'explainer',
    input: {
      brief: input.question,
      criteria: ['Answer from the given result only, and say what it does not cover.'],
    },
    roles: [
      {
        id: 'explainer_role',
        name: 'Explainer',
        prompt: EXPLAIN_PROMPT,
        modelProfile: input.modelProfile,
        allowedWorkTools: ['write_artifact'],
        allowedCollaborationTools: ['submit_result'],
        outputContract: 'text',
      },
    ],
    nodes: [
      {
        id: 'explainer',
        type: 'agent',
        label: 'Explainer',
        roleId: 'explainer_role',
        invocation: 'scheduled',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'answer',
      },
      {
        id: 'output',
        type: 'output',
        label: 'Output',
        inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: 'explainer' }],
        requireApproval: false,
      },
    ],
    controlEdges: [
      { id: 'e1', source: 'explainer', sourcePort: 'out', target: 'output', targetPort: 'in' },
    ],
    capabilityLinks: [],
    limits: { ...DEFAULT_LIMITS, maxModelCalls: Math.min(DEFAULT_LIMITS.maxModelCalls, 4) },
  };
}
