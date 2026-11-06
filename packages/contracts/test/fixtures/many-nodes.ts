import type { CorralDefinition } from '../../src/definition.ts';
import minimal from './minimal.corral.json' with { type: 'json' };

/** An authored graph with more than 64 connected agents, each with its own role. */
export function manyNodeDefinition(
  base: CorralDefinition = minimal as CorralDefinition,
): CorralDefinition {
  const agent = base.nodes.find((node) => node.type === 'agent');
  const output = base.nodes.find((node) => node.type === 'output');
  if (!agent || !output) throw new Error('The fixture needs an agent and an output.');
  const role = base.roles.find((item) => item.id === agent.roleId);
  if (!role) throw new Error('The fixture needs the agent role.');
  const agents = Array.from({ length: 65 }, (_, index) => ({
    ...agent,
    id: `node_${index}`,
    roleId: `role_${index}`,
    label: `Step ${index + 1}`,
  }));
  return {
    ...base,
    entryNodeId: 'node_0',
    roles: agents.map((node, index) => ({ ...role, id: node.roleId, name: `Role ${index + 1}` })),
    nodes: [
      ...agents,
      {
        ...output,
        inputBindings: [{ kind: 'task_output', name: agent.outputName, sourceNodeId: 'node_64' }],
      },
    ],
    controlEdges: agents.map((node, index) => ({
      id: `edge_${index}`,
      source: node.id,
      sourcePort: 'out',
      target: agents[index + 1]?.id ?? output.id,
      targetPort: 'in',
    })),
  };
}

/** The same authored nodes connected by 64 allowed delegation links, not runtime expansion. */
export function manyCapabilityDefinition(): CorralDefinition {
  const definition = manyNodeDefinition();
  const leadRole = definition.roles[0];
  if (!leadRole) throw new Error('Missing lead role.');
  return {
    ...definition,
    roles: [
      {
        ...leadRole,
        allowedCollaborationTools: ['submit_result', 'spawn_subagents', 'await_tasks'],
      },
      ...definition.roles.slice(1),
    ],
    nodes: definition.nodes.map((node) =>
      node.type === 'agent' && node.id !== 'node_0'
        ? { ...node, invocation: 'callable', inputBindings: [] }
        : node.type === 'output'
          ? {
              ...node,
              inputBindings: [{ kind: 'task_output', name: 'text', sourceNodeId: 'node_0' }],
            }
          : node,
    ),
    controlEdges: [
      {
        id: 'edge_output',
        source: 'node_0',
        sourcePort: 'out',
        target: 'output',
        targetPort: 'in',
      },
    ],
    capabilityLinks: Array.from({ length: 64 }, (_, i) => ({
      id: `delegate_${i}`,
      kind: 'delegate',
      sourceNodeId: 'node_0',
      targetNodeId: `node_${i + 1}`,
    })),
  };
}
