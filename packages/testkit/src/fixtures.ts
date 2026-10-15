import { type CorralDefinition, DEFAULT_LIMITS } from '@corral/contracts';

/**
 * Agents wired in the given order and ending in one Output, as a user would draw it.
 * Each agent after the first reads the previous agent's submitted output.
 */
export function linearCorral(agentIds: string[], id = 'linear'): CorralDefinition {
  const [first] = agentIds;
  if (!first) throw new Error('linearCorral needs at least one agent');
  const last = agentIds[agentIds.length - 1] as string;
  return {
    schemaVersion: '0.1',
    id,
    name: `Linear ${agentIds.join(' → ')}`,
    entryNodeId: first,
    input: { brief: 'Compare two options using primary sources.', criteria: ['Cite sources.'] },
    roles: agentIds.map((agentId) => ({
      id: `${agentId}_role`,
      name: agentId,
      prompt: `Act as ${agentId}.`,
      modelProfile: 'model-a',
      allowedWorkTools: ['write_artifact'],
      allowedCollaborationTools: ['submit_result'],
      outputContract: 'text',
    })),
    nodes: [
      ...agentIds.map((agentId, index) => ({
        id: agentId,
        type: 'agent' as const,
        label: agentId,
        roleId: `${agentId}_role`,
        invocation: 'scheduled' as const,
        inputBindings:
          index === 0
            ? [{ kind: 'run_input' as const, name: 'brief' }]
            : [
                {
                  kind: 'task_output' as const,
                  name: 'previous',
                  sourceNodeId: agentIds[index - 1] as string,
                },
              ],
        outputName: 'text',
      })),
      {
        id: 'output',
        type: 'output' as const,
        label: 'Output',
        inputBindings: [{ kind: 'task_output' as const, name: 'final', sourceNodeId: last }],
        requireApproval: false,
      },
    ],
    controlEdges: [...agentIds, 'output'].slice(1).map((target, index) => ({
      id: `e${index + 1}`,
      source: agentIds[index] as string,
      sourcePort: 'out' as const,
      target,
      targetPort: 'in' as const,
    })),
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  };
}
