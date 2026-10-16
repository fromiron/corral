import type { RunProjection } from '@corral/core';

// Roadmap 16: two runs side by side on the figures `corral eval` reports. Unknown stays unknown:
// an unfinished run has no elapsed time.

export type CompareKey =
  | 'status'
  | 'mode'
  | 'models'
  | 'elapsed'
  | 'modelCalls'
  | 'outputTokens'
  | 'executions'
  | 'reviewRounds'
  | 'approvals';

export interface CompareRow {
  key: CompareKey;
  a: string | number | null;
  b: string | number | null;
  differs: boolean;
}

function figures(p: RunProjection): Record<CompareKey, string | number | null> {
  const elapsed =
    p.startedAt && p.endedAt ? Math.max(0, Date.parse(p.endedAt) - Date.parse(p.startedAt)) : null;
  return {
    status: p.status,
    mode: p.mode,
    models:
      Object.values(p.modelProfiles ?? {})
        .map((m) =>
          m.provider && m.modelId ? `${m.profile}: ${m.provider}/${m.modelId}` : `${m.profile}: —`,
        )
        .sort()
        .join(', ') || null,
    elapsed,
    modelCalls: p.budget.modelCalls,
    outputTokens: p.budget.spent,
    executions: p.executionOrder.length,
    reviewRounds: Object.keys(p.iterations).length,
    approvals: Object.values(p.approvals).filter((a) => a.status !== 'pending').length,
  };
}

export function compareRuns(a: RunProjection, b: RunProjection): CompareRow[] {
  const fa = figures(a);
  const fb = figures(b);
  return (Object.keys(fa) as CompareKey[]).map((key) => ({
    key,
    a: fa[key],
    b: fb[key],
    differs: fa[key] !== fb[key],
  }));
}
