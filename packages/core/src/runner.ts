import type { CompiledPlan, PlanStep, PlanTarget } from './compiler/index.ts';

// GraphRunner port. A runner only walks the compiled plan and
// asks the Coordinator to act: it never owns Task state, budgets or artifacts. Each activation
// is identified by (nodeId, iteration), which the Coordinator turns into an activation key so a
// replayed or retried step cannot start a second Task.

export interface IterationRef {
  loopId: string;
  /** 1-based round number inside the Loop. */
  no: number;
}

export type StepOutcome = { ok: true } | { ok: false; reason: string };

/** Why a round that asked to repeat stops instead: its round cap, its budget or a stall. */
export type LoopStop = 'cap_reached' | 'budget_exhausted' | 'stalled';

/** How a Loop round ended: through `repeat` (revise), `exit` (pass), or why it stopped. */
export type RoundOutcome = 'pass' | 'revise' | 'inconclusive' | LoopStop;

export interface RunnerCallbacks {
  /** Runs one scheduled agent step to a settled result. */
  activate(nodeId: string, iteration: IterationRef | null): Promise<StepOutcome>;
  /**
   * Returns the branch port a Decision takes (`pass`, `revise`, a route id, …), or null when the
   * person stopped the run there instead of choosing.
   */
  decide(nodeId: string, iteration: IterationRef | null): Promise<string | null>;
  finalize(outputNodeId: string): Promise<void>;
  loopEntered(loopId: string, no: number): Promise<void>;
  /**
   * A round below its cap asks to repeat: whether the Loop's budget is spent or it stalled.
   * The round cap itself is the plan's `maxIterations`, which the runner checks.
   */
  loopCheck(loopId: string, round: number): Promise<LoopStop | null>;
  /**
   * A Loop must stop and has no `exhausted` path: `continue` runs one more round, `stop` ends
   * the walk with `cap_reached`. The Coordinator asks the person, giving the reason.
   */
  loopCapReached(loopId: string, rounds: number, reason: LoopStop): Promise<'continue' | 'stop'>;
  loopLeft(loopId: string, no: number, outcome: RoundOutcome): Promise<void>;
}

export type RunnerResult =
  | { kind: 'finished'; outputNodeId: string }
  | { kind: 'failed'; nodeId: string; reason: string }
  | { kind: 'rejected'; nodeId: string }
  /** A Loop had to stop, had no `exhausted` path, and the person declined another round. */
  | { kind: 'cap_reached'; loopId: string; iterations: number; reason: LoopStop }
  /** A Decision took a branch that has no edge, such as review `inconclusive`. */
  | { kind: 'needs_user'; nodeId: string; branch: string }
  | { kind: 'stopped' };

/** The part of AbortSignal a runner reads; core stays free of DOM and Node globals. */
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

/** Where a run starts: a box is entered, any other step is run. */
export function entryTarget(plan: CompiledPlan): PlanTarget {
  const kind = plan.steps[plan.entryNodeId]?.kind;
  return { nodeId: plan.entryNodeId, port: kind === 'loop' || kind === 'team' ? 'enter' : 'in' };
}

/** Whether `nodeId` sits somewhere inside the box `boxId`. */
function inside(plan: CompiledPlan, nodeId: string, boxId: string): boolean {
  for (let box = plan.boxes[nodeId]?.parentId ?? null; box; box = plan.boxes[box]?.parentId ?? null)
    if (box === boxId) return true;
  return false;
}

/**
 * The meaning of one plan step. Every runner executes steps through this, so they
 * may differ in how they walk the graph but never in what a step does. `rounds` holds the
 * current round of each open Loop and is updated in place: a Loop that is left is removed.
 */
export async function executeStep(
  plan: CompiledPlan,
  step: PlanStep,
  port: PlanTarget['port'],
  rounds: Record<string, number>,
  callbacks: RunnerCallbacks,
): Promise<StepResult> {
  const iterationOf = (loopId: string | null): IterationRef | null =>
    loopId ? { loopId, no: rounds[loopId] ?? 1 } : null;
  const goTo = (next: PlanTarget | undefined): StepResult =>
    next ? { next } : { end: { kind: 'failed', nodeId: step.nodeId, reason: 'no next step' } };
  const leave = async (loopId: string, outcome: RoundOutcome) => {
    await callbacks.loopLeft(loopId, rounds[loopId] ?? 1, outcome);
    delete rounds[loopId];
  };
  /** Control reached this Loop's exit or repeat from deeper inside: close the inner rounds. */
  const closeInner = async (loopId: string) => {
    const open = Object.keys(rounds).filter((id) => id !== loopId && inside(plan, id, loopId));
    // Innermost first: a Loop inside another closes before it.
    open.sort((a, b) => Number(inside(plan, a, b)) - Number(inside(plan, b, a))).reverse();
    for (const id of open) await leave(id, 'pass');
  };

  switch (step.kind) {
    case 'agent': {
      // The Coordinator has already spent the step's retries; a connected error port takes over.
      const outcome = await callbacks.activate(step.nodeId, iterationOf(step.loopId));
      if (!outcome.ok) {
        const [error] = step.error;
        if (error) return { next: error };
        return { end: { kind: 'failed', nodeId: step.nodeId, reason: outcome.reason } };
      }
      return goTo(step.next[0]);
    }
    case 'decision': {
      const branch = await callbacks.decide(step.nodeId, iterationOf(step.loopId));
      if (branch === null) return { end: { kind: 'rejected', nodeId: step.nodeId } };
      const next = step.branches[branch]?.[0];
      if (next) return { next };
      if (step.loopId && branch === 'inconclusive') {
        await callbacks.loopLeft(step.loopId, rounds[step.loopId] ?? 1, 'inconclusive');
      }
      // A route that happens to be named `reject` is a route, not a stop.
      const terminal = step.mode === 'router' ? undefined : TERMINAL_BRANCHES[branch];
      return {
        end: terminal?.(step.nodeId) ?? {
          kind: 'needs_user',
          nodeId: step.nodeId,
          branch,
        },
      };
    }
    case 'loop': {
      const loopId = step.nodeId;
      if (port === 'enter') {
        rounds[loopId] = 1;
        await callbacks.loopEntered(loopId, 1);
        return goTo(step.body[0]);
      }
      await closeInner(loopId);
      const done = rounds[loopId] ?? 1;
      if (port === 'repeat') {
        const stop =
          done >= step.maxIterations ? 'cap_reached' : await callbacks.loopCheck(loopId, done);
        if (stop) {
          const [exhausted] = step.exhausted;
          if (exhausted) {
            await leave(loopId, stop);
            return { next: exhausted };
          }
          if ((await callbacks.loopCapReached(loopId, done, stop)) === 'stop') {
            await leave(loopId, stop);
            return { end: { kind: 'cap_reached', loopId, iterations: done, reason: stop } };
          }
        }
        await callbacks.loopLeft(loopId, done, 'revise');
        rounds[loopId] = done + 1;
        await callbacks.loopEntered(loopId, done + 1);
        return goTo(step.body[0]);
      }
      await leave(loopId, 'pass');
      return goTo(step.next[0]);
    }
    case 'team':
    case 'join':
      // The compiler marks these RUNTIME_UNSUPPORTED and run start refuses them.
      throw new Error(`${step.kind} steps do not run in this runtime`);
    case 'output':
      await callbacks.finalize(step.nodeId);
      return { end: { kind: 'finished', outputNodeId: step.nodeId } };
  }
}

/** Every target a step can lead to, for runners that declare edges up front. */
export function targetsOf(step: PlanStep): PlanTarget[] {
  switch (step.kind) {
    case 'agent':
      return [...step.next, ...step.error];
    case 'decision':
      return Object.values(step.branches).flat();
    case 'loop':
      return [...step.body, ...step.next, ...step.exhausted];
    case 'team':
      return [...step.body, ...step.next];
    case 'join':
      return step.next;
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
    let target: PlanTarget = entryTarget(plan);
    for (;;) {
      if (signal?.aborted) return { kind: 'stopped' };
      const step: PlanStep | undefined = plan.steps[target.nodeId];
      if (!step) throw new Error(`plan has no step ${target.nodeId}`);
      const result = await executeStep(plan, step, target.port, rounds, callbacks);
      // A step that settles after a stop must not start the next one.
      if (signal?.aborted) return { kind: 'stopped' };
      if ('end' in result) return result.end;
      target = result.next;
    }
  }
}
