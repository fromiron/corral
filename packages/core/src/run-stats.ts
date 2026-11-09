import { type RunStatus, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary, StoredRun } from './store/run-store.ts';

/** How many finished live runs of one revision the stats count, newest first. */
export const RUN_STATS_LIMIT = 20;

export interface RunStatsRun {
  runId: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
}

/** What one step did in one counted run. */
export interface NodeRunFacts {
  runId: string;
  executions: number;
  failures: number;
  /** Executions that were another attempt of the same task. */
  retries: number;
  /** Reported output tokens of the step's model calls; unreported calls add nothing. */
  outputTokens: number;
  /** Loop rounds started; 0 for other steps. */
  rounds: number;
  /** Whether the Loop's last round ended at its round cap. */
  capReached: boolean;
  /** Times each port of a decision was selected. */
  branches: Record<string, number>;
}

export interface NodeRunStats {
  /** Counted runs in which the step did anything, newest first. */
  perRun: NodeRunFacts[];
}

/**
 * Recent finished live runs of one saved revision, step by step. No live state, no bodies:
 * ids, statuses, times and counts only.
 */
export interface RunStats {
  corralId: string;
  definitionRevision: number;
  /** The counted runs, newest first. */
  runs: RunStatsRun[];
  /** Reported output tokens of every counted run, for each step's share. */
  totalOutputTokens: number;
  /** Only steps that did anything in a counted run. */
  nodes: Record<string, NodeRunStats>;
}

const facts = (runId: string): NodeRunFacts => ({
  runId,
  executions: 0,
  failures: 0,
  retries: 0,
  outputTokens: 0,
  rounds: 0,
  capReached: false,
  branches: {},
});

/** Reads one counted run into per-step facts. */
function factsOf(run: StoredRun): { byNode: Map<string, NodeRunFacts>; outputTokens: number } {
  const { projection } = run;
  const byNode = new Map<string, NodeRunFacts>();
  const of = (nodeId: string) => {
    let entry = byNode.get(nodeId);
    if (!entry) {
      entry = facts(run.runId);
      byNode.set(nodeId, entry);
    }
    return entry;
  };
  let outputTokens = 0;
  for (const executionId of projection.executionOrder) {
    const execution = projection.executions[executionId];
    if (!execution) continue;
    const entry = of(execution.nodeId);
    entry.executions += 1;
    if (execution.status === 'failed') entry.failures += 1;
    if (execution.attemptNo > 1) entry.retries += 1;
    for (const modelCallId of execution.modelCallIds) {
      const tokens = projection.modelCalls[modelCallId]?.usage?.outputTokens ?? 0;
      entry.outputTokens += tokens;
      outputTokens += tokens;
    }
  }
  for (const [loopNodeId, iterationIds] of Object.entries(projection.loopIterations)) {
    if (iterationIds.length === 0) continue;
    const entry = of(loopNodeId);
    entry.rounds = iterationIds.length;
    const last = iterationIds.at(-1);
    entry.capReached = last !== undefined && projection.iterations[last]?.outcome === 'cap_reached';
  }
  for (const selected of Object.values(projection.workflowBranches ?? {})) {
    const entry = of(selected.nodeId);
    entry.branches[selected.selectedPort] = (entry.branches[selected.selectedPort] ?? 0) + 1;
  }
  return { byNode, outputTokens };
}

/**
 * Aggregates the latest finished live runs started from one saved revision. `summaries` may be
 * in any order; only runs of the team that have ended are loaded, newest first, until `limit`
 * of them came from that revision in live mode.
 */
export function runStats(
  target: { corralId: string; definitionRevision: number },
  summaries: readonly RunSummary[],
  load: (runId: string) => StoredRun | null,
  limit = RUN_STATS_LIMIT,
): RunStats {
  const candidates = summaries
    .filter(
      (summary) =>
        summary.corralId === target.corralId && TERMINAL_RUN_STATUSES.has(summary.status),
    )
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  const stats: RunStats = { ...target, runs: [], totalOutputTokens: 0, nodes: {} };
  for (const summary of candidates) {
    if (stats.runs.length >= limit) break;
    const run = load(summary.runId);
    if (!run) continue;
    const source = run.snapshot.source;
    if (
      run.snapshot.mode !== 'live' ||
      source?.corralId !== target.corralId ||
      source.definitionRevision !== target.definitionRevision ||
      !TERMINAL_RUN_STATUSES.has(run.projection.status)
    )
      continue;
    stats.runs.push({
      runId: run.runId,
      status: run.projection.status,
      startedAt: run.snapshot.startedAt,
      endedAt: run.projection.endedAt,
    });
    const { byNode, outputTokens } = factsOf(run);
    stats.totalOutputTokens += outputTokens;
    for (const [nodeId, entry] of byNode) {
      stats.nodes[nodeId] ??= { perRun: [] };
      stats.nodes[nodeId].perRun.push(entry);
    }
  }
  return stats;
}
