import type { CorralDefinition } from '@corral/contracts';
import type { NodeRunFacts, RunStats } from '@corral/core';

/** One run behind a figure, with what the figure counted in it. */
export interface FigureRun {
  runId: string;
  value: number;
}

export type StatFigure =
  | { kind: 'rounds'; average: number; runs: FigureRun[] }
  | { kind: 'cap'; hit: number; of: number; runs: FigureRun[] }
  | { kind: 'branch'; port: string; count: number; runs: FigureRun[] }
  | { kind: 'tokens'; share: number; runs: FigureRun[] }
  | { kind: 'failures'; count: number; runs: FigureRun[] }
  | { kind: 'retries'; count: number; runs: FigureRun[] }
  | { kind: 'idle'; runs: [] };

const sum = (runs: readonly FigureRun[]) => runs.reduce((total, run) => total + run.value, 0);
const pick = (perRun: readonly NodeRunFacts[], value: (facts: NodeRunFacts) => number) =>
  perRun.flatMap((facts) => {
    const counted = value(facts);
    return counted > 0 ? [{ runId: facts.runId, value: counted }] : [];
  });

/**
 * Figures for each step of the draft that the saved revision also has: loops, decisions and
 * agents. Steps added since the save get none; a step that never ran reads as idle.
 */
export function statFigures(
  draft: CorralDefinition,
  saved: CorralDefinition,
  stats: RunStats,
): Map<string, StatFigure[]> {
  const figures = new Map<string, StatFigure[]>();
  if (stats.runs.length === 0) return figures;
  const savedIds = new Set(saved.nodes.map((node) => node.id));
  for (const node of draft.nodes) {
    if (!savedIds.has(node.id)) continue;
    if (node.type !== 'loop' && node.type !== 'decision' && node.type !== 'agent') continue;
    const perRun = stats.nodes[node.id]?.perRun ?? [];
    const shown: StatFigure[] = [];
    if (node.type === 'loop') {
      const rounds = pick(perRun, (facts) => facts.rounds);
      if (rounds.length) {
        shown.push({ kind: 'rounds', average: sum(rounds) / rounds.length, runs: rounds });
        const capped = pick(perRun, (facts) => (facts.capReached ? facts.rounds : 0));
        shown.push({ kind: 'cap', hit: capped.length, of: stats.runs.length, runs: capped });
      }
    } else if (node.type === 'decision') {
      const ports = new Set(perRun.flatMap((facts) => Object.keys(facts.branches)));
      const branches = [...ports].map((port) => {
        const runs = pick(perRun, (facts) => facts.branches[port] ?? 0);
        return { kind: 'branch' as const, port, count: sum(runs), runs };
      });
      branches.sort((a, b) => b.count - a.count || a.port.localeCompare(b.port));
      shown.push(...branches);
    } else if (perRun.some((facts) => facts.executions > 0)) {
      const tokens = pick(perRun, (facts) => facts.outputTokens);
      shown.push({
        kind: 'tokens',
        share: stats.totalOutputTokens > 0 ? sum(tokens) / stats.totalOutputTokens : 0,
        runs: tokens,
      });
      const failures = pick(perRun, (facts) => facts.failures);
      if (failures.length) shown.push({ kind: 'failures', count: sum(failures), runs: failures });
      const retries = pick(perRun, (facts) => facts.retries);
      if (retries.length) shown.push({ kind: 'retries', count: sum(retries), runs: retries });
    }
    figures.set(node.id, shown.length ? shown : [{ kind: 'idle', runs: [] }]);
  }
  return figures;
}
