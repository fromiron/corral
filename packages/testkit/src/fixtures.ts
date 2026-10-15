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

/**
 * Research → Writer → Output, where Research may delegate to a callable Helper and the
 * Writer may ask a callable Responder (Spec §6 without the review Loop, which is P5).
 */
export function collaborationCorral(id = 'collab'): CorralDefinition {
  const role = (
    roleId: string,
    name: string,
    collaboration: CorralDefinition['roles'][number]['allowedCollaborationTools'],
    outputContract: CorralDefinition['roles'][number]['outputContract'] = 'notes',
  ): CorralDefinition['roles'][number] => ({
    id: roleId,
    name,
    prompt: `Act as the ${name}.`,
    modelProfile: 'model-a',
    allowedWorkTools: ['write_artifact'],
    allowedCollaborationTools: collaboration,
    outputContract,
  });
  return {
    schemaVersion: '0.1',
    id,
    name: 'Research brief',
    entryNodeId: 'research',
    input: { brief: 'Compare two options using primary sources.', criteria: ['Cite sources.'] },
    roles: [
      role('researcher', 'Researcher', [
        'spawn_subagents',
        'await_tasks',
        'read_artifact',
        'submit_result',
      ]),
      role('helper', 'Research Helper', ['read_artifact', 'submit_result']),
      role('writer', 'Writer', ['ask', 'read_artifact', 'submit_result'], 'draft'),
      role('responder', 'Source Responder', ['reply', 'read_artifact']),
    ],
    nodes: [
      {
        id: 'research',
        type: 'agent',
        label: 'Research',
        roleId: 'researcher',
        invocation: 'scheduled',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'notes',
      },
      {
        id: 'helper',
        type: 'agent',
        label: 'Research Helper',
        roleId: 'helper',
        invocation: 'callable',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'notes-part',
      },
      {
        id: 'write',
        type: 'agent',
        label: 'Writer',
        roleId: 'writer',
        invocation: 'scheduled',
        inputBindings: [{ kind: 'task_output', name: 'notes', sourceNodeId: 'research' }],
        outputName: 'draft',
      },
      {
        id: 'respond',
        type: 'agent',
        label: 'Source Responder',
        roleId: 'responder',
        invocation: 'callable',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'answer',
      },
      {
        id: 'output',
        type: 'output',
        label: 'Output',
        inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: 'write' }],
        requireApproval: false,
      },
    ],
    controlEdges: [
      { id: 'e1', source: 'research', sourcePort: 'out', target: 'write', targetPort: 'in' },
      { id: 'e2', source: 'write', sourcePort: 'out', target: 'output', targetPort: 'in' },
    ],
    capabilityLinks: [
      { id: 'cap1', kind: 'delegate', sourceNodeId: 'research', targetNodeId: 'helper' },
      { id: 'cap2', kind: 'question', sourceNodeId: 'write', targetNodeId: 'respond' },
    ],
    limits: DEFAULT_LIMITS,
  };
}
