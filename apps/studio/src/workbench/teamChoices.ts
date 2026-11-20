import type { HarnessApi } from '@corral/client';
import {
  type AgentLibrary,
  BUILTIN_AGENTS,
  type ComposableAgent,
  type ComposableSkill,
  ROLE_PRESET_IDS,
  type RolePresetId,
  roleFromPreset,
} from '@corral/core';
import { loadSkillCatalog, usableSkill } from './harness/skillCatalog.ts';

/**
 * The built-in agents as "add agent" offers them, in their order and named on screen. The bundled
 * description goes with each: it is how a model tells the judge from the reviewer.
 */
export function builtinComposableAgents(nameOf: (id: RolePresetId) => string): ComposableAgent[] {
  return ROLE_PRESET_IDS.map((id) => {
    const { id: _id, origin: _origin, ...role } = roleFromPreset(id, id, nameOf(id));
    const description = BUILTIN_AGENTS.find((agent) => agent.id === id)?.description;
    return {
      role,
      origin: { kind: 'preset', presetId: id },
      builtin: true,
      ...(description ? { description } : {}),
    };
  });
}

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
