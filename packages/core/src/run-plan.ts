import type { CorralDefinition } from '@corral/contracts';
import { type CompiledPlan, type CompileOptions, compileDefinition } from './compiler/index.ts';

// What the runtime executes: the same compiler as the editor (the editor is not a trust
// boundary). The compiler accepts the whole team graph model; a definition that uses a construct
// this runtime does not run yet carries RUNTIME_UNSUPPORTED warnings and is refused here.

export interface PlanIssue {
  code: 'GRAPH_INVALID' | 'COMMAND_NOT_SUPPORTED' | 'RUNTIME_UNSUPPORTED';
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
  const compiled = compileDefinition(definition, options);
  if (!compiled.ok) {
    return {
      ok: false,
      issues: compiled.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => issue('GRAPH_INVALID', d)),
    };
  }
  const unsupported = compiled.diagnostics.filter((d) => d.code === 'RUNTIME_UNSUPPORTED');
  if (unsupported.length > 0) {
    return { ok: false, issues: unsupported.map((d) => issue('RUNTIME_UNSUPPORTED', d)) };
  }
  return { ok: true, definition: compiled.definition, plan: compiled.plan };
}
