import type { CorralDefinition } from '@corral/contracts';
import type { CompiledPlan, PlanTarget } from './compiler/index.ts';

// Where a fork may start and what it copies (docs/specs/features/fork-and-breakpoints.md).

/** Every step reachable from `nodeId`, the step itself and the members of boxes it reaches. */
export function reachableFrom(plan: CompiledPlan, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const queue = [nodeId];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const step = plan.steps[id];
    const targets: PlanTarget[] = !step
      ? []
      : step.kind === 'agent'
        ? [...step.next, ...step.error]
        : step.kind === 'decision'
          ? Object.values(step.branches).flat()
          : step.kind === 'loop'
            ? [...step.body, ...step.next, ...step.exhausted]
            : step.kind === 'team'
              ? [...step.body, ...step.next]
              : step.kind === 'join'
                ? step.next
                : [];
    for (const target of targets) queue.push(target.nodeId);
  }
  return seen;
}

export interface ForkIssue {
  code: 'GRAPH_INVALID' | 'TARGET_NOT_FOUND';
  message: string;
}

/**
 * The steps a fork at `nodeId` runs: a top-level scheduled Agent, Loop or Team outside any
 * parallel branch, so every gathering Join it reaches also has its fan-out reached.
 */
export function forkSteps(
  definition: CorralDefinition,
  plan: CompiledPlan,
  nodeId: string,
): { reached: Set<string> } | { error: ForkIssue } {
  if (!definition.nodes.some((node) => node.id === nodeId))
    return { error: { code: 'TARGET_NOT_FOUND', message: `this team has no step ${nodeId}` } };
  const step = plan.steps[nodeId];
  if (!step || !['agent', 'loop', 'team'].includes(step.kind) || step.parentId !== null)
    return {
      error: {
        code: 'GRAPH_INVALID',
        message: `${nodeId}: only a top-level scheduled Agent, Loop or Team can be forked`,
      },
    };
  const reached = reachableFrom(plan, nodeId);
  for (const id of reached) {
    const join = plan.steps[id];
    if (
      join?.kind === 'join' &&
      join.gathers &&
      !reached.has(join.gathers.port.split('\u0000')[0] ?? '')
    )
      return {
        error: { code: 'GRAPH_INVALID', message: `${nodeId} is inside a parallel branch` },
      };
  }
  return { reached };
}

/**
 * The scheduled nodes a fork does not run again whose results the remaining nodes read with
 * `task_output`, each with whether a reader requires it (a binding that is not optional).
 */
export function carriedSources(
  definition: CorralDefinition,
  plan: CompiledPlan,
  reached: ReadonlySet<string>,
): Map<string, boolean> {
  const needed = new Map<string, boolean>();
  for (const node of definition.nodes) {
    const runs = reached.has(node.id) || (node.type === 'agent' && node.invocation === 'callable');
    if (!runs || !('inputBindings' in node)) continue;
    for (const binding of node.inputBindings ?? []) {
      const source = binding.sourceNodeId;
      if (binding.kind !== 'task_output' || !source || reached.has(source) || !plan.steps[source])
        continue;
      needed.set(source, (needed.get(source) ?? false) || !binding.optional);
    }
  }
  return needed;
}

/** The plan a fork runs: its step is the start and only the steps it reaches are left. */
export function forkPlan(
  plan: CompiledPlan,
  nodeId: string,
  reached: ReadonlySet<string>,
): CompiledPlan {
  const keep = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => reached.has(id)));
  return {
    ...plan,
    entryNodeId: nodeId,
    order: plan.order.filter((id) => reached.has(id)),
    steps: keep(plan.steps),
    loops: keep(plan.loops),
    boxes: keep(plan.boxes),
  };
}
