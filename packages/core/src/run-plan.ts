import type { CorralDefinition } from '@corral/contracts';
import { type CompiledPlan, type CompileOptions, compileDefinition } from './compiler/index.ts';
import { expandReferences } from './expand-teams.ts';

// What the runtime executes: the same compiler as the editor (the editor is not a trust
// boundary). Reference Teams are expanded into the definition the run keeps, which is compiled
// again.

export interface PlanIssue {
  code: 'GRAPH_INVALID';
  message: string;
  nodeId?: string;
  edgeId?: string;
  linkId?: string;
}

export type RunPlan =
  | { ok: true; definition: CorralDefinition; plan: CompiledPlan }
  | { ok: false; issues: PlanIssue[] };

const issue = (
  code: PlanIssue['code'],
  { message, nodeId, edgeId, linkId }: Omit<PlanIssue, 'code'>,
): PlanIssue => ({
  code,
  message,
  ...(nodeId ? { nodeId } : {}),
  ...(edgeId ? { edgeId } : {}),
  ...(linkId ? { linkId } : {}),
});

export function planRun(definition: unknown, options?: CompileOptions): RunPlan {
  const checked = compileDefinition(definition, options);
  const references =
    checked.ok &&
    checked.definition.nodes.some((n) => n.type === 'team' && n.source.kind === 'reference');
  const compiled =
    checked.ok && references && options?.resolveTeam
      ? compileDefinition(expandReferences(checked.definition, options.resolveTeam), options)
      : checked;
  if (!compiled.ok) {
    return {
      ok: false,
      issues: compiled.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => issue('GRAPH_INVALID', d)),
    };
  }
  // The expanded definition holds each reference Team's members as inline ones; a Loop still
  // changes only the Agents it held before expansion (features/team-graph.md, "구조 규칙" 4).
  if (checked.ok && compiled !== checked)
    for (const [loopId, agents] of Object.entries(loopAgents(checked.plan)))
      if (compiled.plan.loops[loopId]) compiled.plan.loops[loopId].agents = agents;
  return { ok: true, definition: compiled.definition, plan: compiled.plan };
}

/** Each Loop's Agents, reference Teams' own Loops under their expanded ids. */
function loopAgents(plan: CompiledPlan, prefix = ''): Record<string, string[]> {
  const agents: Record<string, string[]> = {};
  for (const [loopId, loop] of Object.entries(plan.loops))
    agents[prefix + loopId] = loop.agents.map((id) => prefix + id);
  for (const [teamId, reference] of Object.entries(plan.references))
    Object.assign(agents, loopAgents(reference.plan, `${prefix}${teamId}.`));
  return agents;
}
