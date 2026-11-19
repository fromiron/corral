import { CorralDefinition, isWorkAgent, type RunLimits } from '@corral/contracts';
import { workerDepths } from './compiler/call-depth.ts';
import type { ResolveTeam } from './expand-teams.ts';

export interface SharedOutriderTarget {
  nodeId: string;
  label: string;
  /** The authored reference containing this worker, including through nested references. */
  referenceNodeId?: string;
  unavailable?: 'depth' | 'questions' | 'spawns';
}

/** Authored workers, including pinned references. Safe to inspect a still-incomplete editor draft. */
export function sharedOutriderTargets(
  definition: CorralDefinition,
  resolve?: ResolveTeam,
  limits: RunLimits = definition.limits,
): SharedOutriderTarget[] {
  const rows: SharedOutriderTarget[] = [];
  function visit(
    team: CorralDefinition,
    prefix: string,
    labels: string[],
    parents: string[],
    referenceNodeId?: string,
  ) {
    const depths = workerDepths(team.nodes, team.capabilityLinks);
    // The work must be reached with a question and a child execution still available.
    const reservingQuestion = workerDepths(
      team.nodes,
      team.capabilityLinks,
      undefined,
      limits.maxQuestions - 1,
    );
    for (const node of team.nodes) {
      if (node.type === 'team' && node.source.kind === 'reference' && resolve) {
        const { corralId, definitionRevision } = node.source;
        if (parents.includes(corralId)) continue;
        const saved = CorralDefinition.safeParse(resolve(corralId, definitionRevision));
        if (saved.success)
          visit(
            saved.data,
            `${prefix}${node.id}.`,
            [...labels, node.label],
            [...parents, corralId],
            referenceNodeId ?? node.id,
          );
      }
      if (!isWorkAgent(node)) continue;
      const depth = depths.get(node.id) ?? Number.POSITIVE_INFINITY;
      const row: SharedOutriderTarget = {
        nodeId: prefix + node.id,
        label: [...labels, node.label].join(' / '),
        ...(referenceNodeId ? { referenceNodeId } : {}),
      };
      if (limits.maxQuestions === 0) row.unavailable = 'questions';
      else if (depth + 1 > limits.maxDelegationDepth) row.unavailable = 'depth';
      else if (depth + 1 > limits.maxSpawns) row.unavailable = 'spawns';
      else if (
        (reservingQuestion.get(node.id) ?? Infinity) >=
        Math.min(limits.maxSpawns, limits.maxDelegationDepth)
      )
        row.unavailable = 'questions';
      rows.push(row);
    }
  }
  visit(definition, '', [], [definition.id]);
  return rows;
}

/** Pick an unoccupied identifier; authored nodes with the same name have no special meaning. */
function freshId(used: Set<string>, base: string): string {
  let id = base;
  for (let suffix = 2; used.has(id); suffix++) id = `${base}_${suffix}`;
  used.add(id);
  return id;
}

/** Materializes one scope into its execution copy. Its source always contains the original nodes. */
export function materializeSharedOutrider(
  expanded: CorralDefinition,
  source: CorralDefinition,
  resolve: ResolveTeam | undefined,
  limits: RunLimits,
): { definition: CorralDefinition; responderId?: string } {
  const { sharedOutrider, ...definition } = expanded;
  if (!sharedOutrider) return { definition: expanded };
  const selected =
    sharedOutrider.targets.kind === 'selected' ? new Set(sharedOutrider.targets.nodeIds) : null;
  const targets = new Set(
    sharedOutriderTargets(source, resolve, limits)
      .filter((row) => !row.unavailable && (!selected || selected.has(row.nodeId)))
      .map((row) => row.nodeId),
  );
  if (!targets.size) return { definition };

  const targetRoles = new Set(
    definition.nodes.flatMap((node) =>
      isWorkAgent(node) && targets.has(node.id) ? [node.roleId] : [],
    ),
  );
  const roleId = freshId(new Set(definition.roles.map((r) => r.id)), 'shared_outrider_role');
  const responderId = freshId(new Set(definition.nodes.map((n) => n.id)), 'shared_outrider');
  const connectionIds = new Set(
    [...definition.controlEdges, ...definition.capabilityLinks].map((l) => l.id),
  );
  const name = 'Outrider';
  return {
    responderId,
    definition: {
      ...definition,
      roles: [
        ...definition.roles.map((role) =>
          targetRoles.has(role.id) && !role.allowedCollaborationTools.includes('ask')
            ? {
                ...role,
                allowedCollaborationTools: [...role.allowedCollaborationTools, 'ask' as const],
              }
            : role,
        ),
        {
          id: roleId,
          name,
          prompt: sharedOutrider.principles,
          modelProfile: sharedOutrider.modelProfile,
          allowedWorkTools: [],
          allowedCollaborationTools: ['reply', 'read_artifact'],
          outputContract: 'text',
        },
      ],
      nodes: [
        ...definition.nodes,
        {
          id: responderId,
          label: name,
          type: 'agent',
          invocation: 'callable',
          roleId,
          inputBindings: [],
          outputName: 'answer',
        },
      ],
      capabilityLinks: [
        ...definition.capabilityLinks,
        ...[...targets].map((sourceNodeId, index) => ({
          id: freshId(connectionIds, `shared_consult_${index + 1}`),
          kind: 'question' as const,
          sourceNodeId,
          targetNodeId: responderId,
        })),
      ],
    },
  };
}
