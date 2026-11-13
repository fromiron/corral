import type { AgentRole, CollaborationTool, CorralNode, WorkTool } from '@corral/contracts';
import { adviceSender } from './channel.ts';

// The advisor's tools are the Coordinator's (docs/specs/features/advisor.md, 계약): the read tools
// its role picked from this list, reading what the watched roles wrote, and `advise`.

export const ADVISOR_WORK_TOOLS: readonly WorkTool[] = [
  'search',
  'read_document',
  'list_files',
  'read_file',
];
export const ADVISOR_COLLABORATION_TOOLS: readonly CollaborationTool[] = [
  'read_artifact',
  'advise',
];

/**
 * The role an advisor's execution runs with: whatever else the role lists is not offered, and
 * its work style is not bound. It answers no one, so it writes no answer.
 */
export function advisorRole(role: AgentRole): AgentRole {
  const { harness: _workStyle, answer: _answer, ...rest } = role;
  return {
    ...rest,
    // The name its advice is headed with, so its instructions name it the same way.
    name: adviceSender(role.name),
    allowedWorkTools: role.allowedWorkTools.filter((tool) => ADVISOR_WORK_TOOLS.includes(tool)),
    allowedCollaborationTools: [...ADVISOR_COLLABORATION_TOOLS],
  };
}

/** Whether an advisor's execution may use this tool at all; the arguments are checked after. */
export function advisorMayUse(role: AgentRole, tool: string): boolean {
  return (
    (ADVISOR_COLLABORATION_TOOLS as readonly string[]).includes(tool) ||
    ((ADVISOR_WORK_TOOLS as readonly string[]).includes(tool) &&
      (role.allowedWorkTools as readonly string[]).includes(tool))
  );
}

/**
 * The roles a team's advisors run: those of its observer nodes, and any role that lists `advise`.
 * They are no one's delegate. The team editor's role import (`importableRoles` in
 * `packages/react/src/team-editor/commands.ts`) leaves out the same roles; keep the two alike.
 */
export function advisorRoleIds(definition: {
  nodes: readonly CorralNode[];
  roles: readonly AgentRole[];
}): Set<string> {
  return new Set([
    ...definition.nodes.flatMap((node) =>
      node.type === 'agent' && node.invocation === 'observer' ? [node.roleId] : [],
    ),
    ...definition.roles
      .filter((role) => role.allowedCollaborationTools.includes('advise'))
      .map((role) => role.id),
  ]);
}
