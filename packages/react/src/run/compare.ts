import { type RunProjection, usageTotals } from '@corral/core';

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
  const usage = usageTotals(p);
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
    modelCalls: usage.requests,
    outputTokens: usage.outputTokens,
    executions: p.executionOrder.length,
    reviewRounds: Object.keys(p.iterations).length,
    // Decisions the person made: the runtime's closings and allow-for-run passes are not theirs.
    approvals: Object.values(p.approvals).filter((a) => a.resolvedBy === 'person').length,
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
