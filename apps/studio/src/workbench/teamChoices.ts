import type { HarnessApi } from '@corral/client';
import {
  type AgentLibrary,
  builtinComposableAgents,
  type ComposableAgent,
  type ComposableSkill,
  type RolePresetId,
} from '@corral/core';
import { loadSkillCatalog, usableSkill } from './harness/skillCatalog.ts';

/**
 * What the editor can pick by hand for a new team (team-assistant.md item 8): the built-in agents,
 * then the project's own agents, and the skills "add skill" offers. Without a harness (the browser
 * demo) there are no skills to offer. A failed read fails the whole list.
 */
export async function teamChoices({
  projectId,
  agents,
  harnesses,
  presetName,
}: {
  projectId: string;
  agents: Pick<AgentLibrary, 'list'>;
  harnesses: HarnessApi | null;
  presetName(id: RolePresetId): string;
}): Promise<{ agents: ComposableAgent[]; skills: ComposableSkill[] }> {
  const [own, catalog] = await Promise.all([
    agents.list(projectId),
    harnesses ? loadSkillCatalog(harnesses) : null,
  ]);
  return {
    agents: [
      ...builtinComposableAgents(presetName),
      ...own
        .filter((agent) => !agent.archivedAt)
        .map(
          (agent): ComposableAgent => ({
            role: agent.role,
            origin: { kind: 'library', agentId: agent.agentId, revision: agent.revision },
          }),
        ),
    ],
    skills: catalog
      ? catalog.entries
          .filter((entry) => usableSkill(entry, catalog))
          .map((entry) => ({
            ref: { resourceHash: entry.resourceHash, entry: entry.entry },
            name: entry.name,
            description: entry.description,
          }))
      : [],
  };
}
