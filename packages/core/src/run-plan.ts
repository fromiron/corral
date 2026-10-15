import type { CorralDefinition } from '@corral/contracts';
import { type CompiledPlan, compileDefinition } from './compiler/index.ts';

// What the runtime can execute today. It runs the same compiler as the editor; anything the
// compiler accepts but this runtime cannot run yet is refused with the node named, never run
// another way (Decision steps need review verdicts and approvals, P5).

export interface PlanIssue {
  code: 'GRAPH_INVALID' | 'COMMAND_NOT_SUPPORTED';
  message: string;
  nodeId?: string;
  edgeId?: string;
  linkId?: string;
}

export interface RunPlanOptions {
  /** True when a decision policy is installed (tests today, review and approvals in P5). */
  decisions?: boolean;
}

export type RunPlan =
  | { ok: true; definition: CorralDefinition; plan: CompiledPlan }
  | { ok: false; issues: PlanIssue[] };

export function planRun(definition: unknown, options: RunPlanOptions = {}): RunPlan {
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
  for (const id of plan.order) {
    const step = plan.steps[id];
    if (step?.kind === 'decision' && !options.decisions) {
      issues.push({
        code: 'COMMAND_NOT_SUPPORTED',
        message: `Decision ${id} needs reviews and approvals, which this version cannot run yet`,
        nodeId: id,
      });
    }
    if (step?.kind === 'output' && step.requireApproval) {
      issues.push({
        code: 'COMMAND_NOT_SUPPORTED',
        message: `final approval on ${id} needs approvals, which this version cannot run yet`,
        nodeId: id,
      });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, definition: compiled.definition, plan };
}
