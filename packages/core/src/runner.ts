import type { CompiledPlan, PlanStep, PlanTarget } from './compiler/index.ts';

// GraphRunner port (Technical-Design §4.3, ADR-004). A runner only walks the compiled plan and
// asks the Coordinator to act: it never owns Task state, budgets or artifacts. Each activation
// is identified by (nodeId, iteration), which the Coordinator turns into an activation key so a
// replayed or retried step cannot start a second Task.

export interface IterationRef {
  loopId: string;
  /** 1-based round number inside the Loop. */
  no: number;
}

export type StepOutcome = { ok: true } | { ok: false; reason: string };

/** How a Loop round ended: through `repeat` (revise), `exit` (pass), or neither. */
export type RoundOutcome = 'pass' | 'revise' | 'inconclusive' | 'cap_reached';

export interface RunnerCallbacks {
  /** Runs one scheduled agent step to a settled result. */
  activate(nodeId: string, iteration: IterationRef | null): Promise<StepOutcome>;
  /** Returns the branch port a Decision takes (`pass`, `revise`, `inconclusive`, `approve`, …). */
  decide(nodeId: string, iteration: IterationRef | null): Promise<string>;
  finalize(outputNodeId: string): Promise<void>;
  loopEntered(loopId: string, no: number): Promise<void>;
  loopLeft(loopId: string, no: number, outcome: RoundOutcome): Promise<void>;
}

export type RunnerResult =
  | { kind: 'finished'; outputNodeId: string }
  | { kind: 'failed'; nodeId: string; reason: string }
  | { kind: 'rejected'; nodeId: string }
  /** A Loop asked for another round past its cap; the Coordinator asks the user (Spec §5.3). */
  | { kind: 'cap_reached'; loopId: string; iterations: number }
  /** A Decision took a branch that has no edge, such as review `inconclusive`. */
  | { kind: 'needs_user'; nodeId: string; branch: string }
  | { kind: 'stopped' };

/** The part of AbortSignal a runner reads; core stays free of DOM and Node globals (ADR-014). */
export interface StopSignal {
  readonly aborted: boolean;
}

export interface GraphRunner {
  run(plan: CompiledPlan, callbacks: RunnerCallbacks, signal?: StopSignal): Promise<RunnerResult>;
}

/** Branches that end the run instead of following an edge when nothing is connected. */
const TERMINAL_BRANCHES: Record<string, (nodeId: string) => RunnerResult> = {
  reject: (nodeId) => ({ kind: 'rejected', nodeId }),
};

/** Where a step leads: the next target, or how the run ends. */
export type StepResult = { next: PlanTarget } | { end: RunnerResult };

/**
 * The meaning of one plan step (Spec §5.3). Every runner executes steps through this, so they
 * may differ in how they walk the graph but never in what a step does. `rounds` holds the
 * current round of each Loop and is updated in place.
 */
export async function executeStep(
  step: PlanStep,
  port: PlanTarget['port'],
  rounds: Record<string, number>,
  callbacks: RunnerCallbacks,
): Promise<StepResult> {
  const iterationOf = (loopId: string | null): IterationRef | null =>
    loopId ? { loopId, no: rounds[loopId] ?? 1 } : null;
  const goTo = (next: PlanTarget | null): StepResult =>
    next ? { next } : { end: { kind: 'failed', nodeId: step.nodeId, reason: 'no next step' } };

  switch (step.kind) {
    case 'agent': {
      const outcome = await callbacks.activate(step.nodeId, iterationOf(step.loopId));
      if (!outcome.ok) {
        return { end: { kind: 'failed', nodeId: step.nodeId, reason: outcome.reason } };
      }
      return goTo(step.next);
    }
    case 'decision': {
      const branch = await callbacks.decide(step.nodeId, iterationOf(step.loopId));
      const next: PlanTarget | null | undefined =
        step.branches[branch as keyof typeof step.branches];
      if (next) return { next };
      if (step.loopId && branch === 'inconclusive') {
        await callbacks.loopLeft(step.loopId, rounds[step.loopId] ?? 1, 'inconclusive');
      }
      return {
        end: TERMINAL_BRANCHES[branch]?.(step.nodeId) ?? {
          kind: 'needs_user',
          nodeId: step.nodeId,
          branch,
        },
      };
    }
    case 'loop': {
      const loopId = step.nodeId;
      const done = rounds[loopId] ?? 1;
      if (port === 'enter') {
        rounds[loopId] = 1;
        await callbacks.loopEntered(loopId, 1);
        return { next: step.body };
      }
      if (port === 'repeat') {
        if (done >= step.maxIterations) {
          await callbacks.loopLeft(loopId, done, 'cap_reached');
          return { end: { kind: 'cap_reached', loopId, iterations: done } };
        }
        await callbacks.loopLeft(loopId, done, 'revise');
        rounds[loopId] = done + 1;
        await callbacks.loopEntered(loopId, done + 1);
        return { next: step.body };
      }
      await callbacks.loopLeft(loopId, done, 'pass');
      return { next: step.next };
    }
    case 'output':
      await callbacks.finalize(step.nodeId);
      return { end: { kind: 'finished', outputNodeId: step.nodeId } };
  }
}

/** Every target a step can lead to, for runners that declare edges up front. */
export function targetsOf(step: PlanStep): PlanTarget[] {
  switch (step.kind) {
    case 'agent':
      return step.next ? [step.next] : [];
    case 'decision':
      return Object.values(step.branches).filter(
        (t): t is PlanTarget => t !== null && t !== undefined,
      );
    case 'loop':
      return [step.body, step.next];
    case 'output':
      return [];
  }
}

/**
 * Reference runner: a plain loop over the IR. It defines the expected order for runner parity
 * tests and runs where LangGraph is not wanted.
 */
export class SequentialPlanRunner implements GraphRunner {
  async run(
    plan: CompiledPlan,
    callbacks: RunnerCallbacks,
    signal?: StopSignal,
  ): Promise<RunnerResult> {
    const rounds: Record<string, number> = {};
    let target: PlanTarget = { nodeId: plan.entryNodeId, port: 'in' };
    for (;;) {
      if (signal?.aborted) return { kind: 'stopped' };
      const step: PlanStep | undefined = plan.steps[target.nodeId];
      if (!step) throw new Error(`plan has no step ${target.nodeId}`);
      const result = await executeStep(step, target.port, rounds, callbacks);
      // A step that settles after a stop must not start the next one.
      if (signal?.aborted) return { kind: 'stopped' };
      if ('end' in result) return result.end;
      target = result.next;
    }
  }
}
