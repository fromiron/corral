import { compileDefinition } from './compiler/index.ts';

// Runner plan for the current runtime: scheduled Agent → … → Agent → Output. It runs the same
// compiler as the editor; anything the compiler accepts but this runner cannot execute yet
// (Loop and Decision steps, P2/P5) is refused with the node named, never run another way.

export interface PlanIssue {
  code: 'GRAPH_INVALID';
  message: string;
  nodeId?: string;
  edgeId?: string;
  linkId?: string;
}

export type LinearPlan =
  | { ok: true; agentNodeIds: string[]; outputNodeId: string }
  | { ok: false; issues: PlanIssue[] };

export function planLinearRun(definition: unknown): LinearPlan {
  const compiled = compileDefinition(definition);
  if (!compiled.ok) {
    return {
      ok: false,
      issues: compiled.diagnostics
        .filter((d) => d.severity === 'error')
        .map(({ message, nodeId, edgeId, linkId }) => ({
          code: 'GRAPH_INVALID' as const,
          message,
          ...(nodeId ? { nodeId } : {}),
          ...(edgeId ? { edgeId } : {}),
          ...(linkId ? { linkId } : {}),
        })),
    };
  }

  const { plan } = compiled;
  const issues: PlanIssue[] = [];
  const agentNodeIds: string[] = [];
  let outputNodeId: string | null = null;
  for (const id of plan.order) {
    const step = plan.steps[id];
    if (step?.kind === 'agent') agentNodeIds.push(id);
    else if (step?.kind === 'output') outputNodeId ??= id;
    else if (step) {
      issues.push({
        code: 'GRAPH_INVALID',
        message: `${step.kind} steps run once the graph runner (P2) and review loops (P5) land`,
        nodeId: id,
      });
    }
  }
  if (issues.length > 0 || !outputNodeId) return { ok: false, issues };
  return { ok: true, agentNodeIds, outputNodeId };
}
