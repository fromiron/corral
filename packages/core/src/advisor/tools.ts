import type { AgentRole, CollaborationTool, WorkTool } from '@corral/contracts';
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
