import type { CorralDefinition } from '@corral/contracts';
import { type CompiledPlan, compileDefinition } from './compiler/index.ts';

// What the runtime executes: the same compiler as the editor (the editor is not a trust
// boundary). Since P5 every step the compiler accepts can run, Decisions and approvals included.

export interface PlanIssue {
  code: 'GRAPH_INVALID' | 'COMMAND_NOT_SUPPORTED';
  message: string;
  nodeId?: string;
  edgeId?: string;
  linkId?: string;
}

export type RunPlan =
  | { ok: true; definition: CorralDefinition; plan: CompiledPlan }
  | { ok: false; issues: PlanIssue[] };

export function planRun(definition: unknown): RunPlan {
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
  return { ok: true, definition: compiled.definition, plan };
}
