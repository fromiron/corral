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
export type RoundOutcome = 'pass' | 'revise' | 'inconclusive' | 'cancelled' | LoopStop;

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
  /**
   * A Join lets one path continue. For `any`, `stopped` names the step each other branch was on
   * and `loops` the Loop rounds they had opened: the Coordinator cancels that work, withdraws
   * what it waits on and ends those rounds as cancelled.
   */
  joined(
    joinId: string,
    iteration: IterationRef | null,
    stopped: StepRef[],
    loops: { loopId: string; no: number }[],
  ): Promise<void>;
}

/** One step as one branch runs it: the node and the round it is in. */
export interface StepRef {
  nodeId: string;
  iteration: IterationRef | null;
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

/**
 * Where a step leads: every target of the port it took (more than one starts parallel branches;
 * `port` is `node\u0000port`, as a Join's `gathers` names it), or how the run ends.
 */
export type StepResult = { next: PlanTarget[]; port: string } | { end: RunnerResult };

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
  const goTo = (next: PlanTarget[] | undefined, port: string): StepResult =>
    next?.length
      ? { next, port: `${step.nodeId}\u0000${port}` }
      : { end: { kind: 'failed', nodeId: step.nodeId, reason: 'no next step' } };
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
        if (step.error.length) return goTo(step.error, 'error');
        return { end: { kind: 'failed', nodeId: step.nodeId, reason: outcome.reason } };
      }
      return goTo(step.next, 'out');
    }
    case 'decision': {
      const branch = await callbacks.decide(step.nodeId, iterationOf(step.loopId));
      if (branch === null) return { end: { kind: 'rejected', nodeId: step.nodeId } };
      if (step.branches[branch]?.length) return goTo(step.branches[branch], branch);
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
        return goTo(step.body, 'body');
      }
      await closeInner(loopId);
      const done = rounds[loopId] ?? 1;
      if (port === 'repeat') {
        const stop =
          done >= step.maxIterations ? 'cap_reached' : await callbacks.loopCheck(loopId, done);
        if (stop) {
          if (step.exhausted.length) {
            await leave(loopId, stop);
            return goTo(step.exhausted, 'exhausted');
          }
          if ((await callbacks.loopCapReached(loopId, done, stop)) === 'stop') {
            await leave(loopId, stop);
            return { end: { kind: 'cap_reached', loopId, iterations: done, reason: stop } };
          }
        }
        await callbacks.loopLeft(loopId, done, 'revise');
        rounds[loopId] = done + 1;
        await callbacks.loopEntered(loopId, done + 1);
        return goTo(step.body, 'body');
      }
      await leave(loopId, 'pass');
      return goTo(step.next, 'next');
    }
    case 'join':
      // A Join that gathers branches is the walker's; one fed by a single branch passes on.
      if (step.gathers) throw new Error(`${step.nodeId} gathers branches; the walker joins them`);
      return goTo(step.next, 'out');
    case 'team':
      // The compiler marks Teams RUNTIME_UNSUPPORTED and run start refuses them.
      throw new Error('team steps do not run in this runtime');
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

/** Whether a plan ever runs two branches at once. */
export function hasParallel(plan: CompiledPlan): boolean {
  return Object.values(plan.steps).some(
    (step) =>
      (step.kind === 'join' && step.gathers !== null) ||
      targetsByPort(step).some((targets) => targets.length > 1),
  );
}

function targetsByPort(step: PlanStep): PlanTarget[][] {
  switch (step.kind) {
    case 'agent':
      return [step.next, step.error];
    case 'decision':
      return Object.values(step.branches);
    case 'loop':
      return [step.body, step.next, step.exhausted];
    case 'team':
      return [step.body, step.next];
    case 'join':
      return [step.next];
    case 'output':
      return [];
  }
}

/** The branch a token is on: one entry per fan-out it has not yet rejoined, innermost last. */
interface Fork {
  port: string;
  /** Each time a port fans out is a new instance; its branches share it. */
  instance: number;
  index: number;
  /** Loops open when it fanned out, which stopping a branch must leave alone. */
  loops: string[];
}

interface Token {
  target: PlanTarget;
  rounds: Record<string, number>;
  forks: Fork[];
  current: StepRef | null;
  stopped: boolean;
}

class BranchStopped extends Error {}

/**
 * Walks a plan with parallel branches: every branch moves on its own, and they wait for each
 * other only at a Join (docs/specs/features/team-graph.md, "병렬 실행"). Both runners use it,
 * so they cannot differ in what parallel means. The first branch to end the run ends it.
 */
export async function walkPlan(
  plan: CompiledPlan,
  callbacks: RunnerCallbacks,
  signal?: StopSignal,
): Promise<RunnerResult> {
  let instances = 0;
  const live: Token[] = [];
  const joins = new Map<string, { arrived: Set<number>; fired: boolean }>();
  let result: RunnerResult | null = null;
  let failure: { error: unknown } | null = null;
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (end: RunnerResult) => {
    if (!result && !failure) result = end;
    settle();
  };
  const iterationOf = (token: Token, loopId: string | null): IterationRef | null =>
    loopId ? { loopId, no: token.rounds[loopId] ?? 1 } : null;

  /** A stopped branch reaches the Coordinator no more, whatever it was in the middle of. */
  const guarded = (token: Token): RunnerCallbacks =>
    Object.fromEntries(
      Object.entries(callbacks).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          if (token.stopped || result || failure) throw new BranchStopped();
          return (fn as (...a: unknown[]) => unknown).apply(callbacks, args);
        },
      ]),
    ) as unknown as RunnerCallbacks;

  const spawn = (token: Token) => {
    live.push(token);
    // A new branch starts once the one that fanned out has started its own next step.
    Promise.resolve()
      .then(() => walk(token))
      .catch((error: unknown) => {
        if (error instanceof BranchStopped || token.stopped || result || failure) return;
        failure = { error };
        settle();
      })
      .finally(() => {
        live.splice(live.indexOf(token), 1);
        if (live.length === 0) settle();
      });
  };

  /** Moves a token on to where a step led, starting the other branches of a fan-out. */
  const advance = (token: Token, next: PlanTarget[], port: string) => {
    const [first, ...rest] = next as [PlanTarget, ...PlanTarget[]];
    if (rest.length === 0) {
      token.target = first;
      return;
    }
    const fork = { port, instance: ++instances, loops: Object.keys(token.rounds) };
    const parent = { rounds: token.rounds, forks: token.forks };
    rest.forEach((target, i) => {
      spawn({
        target,
        rounds: { ...parent.rounds },
        forks: [...parent.forks, { ...fork, index: i + 1 }],
        current: null,
        stopped: false,
      });
    });
    token.target = first;
    token.rounds = { ...parent.rounds };
    token.forks = [...parent.forks, { ...fork, index: 0 }];
  };

  /** A branch reaches a Join that gathers: true when this token goes on past it. */
  const arrive = async (token: Token, step: Extract<PlanStep, { kind: 'join' }>) => {
    const gathers = step.gathers as { port: string; width: number };
    const fork = token.forks.at(-1);
    if (fork?.port !== gathers.port)
      throw new Error(`${step.nodeId} was reached outside the fan-out it gathers`);
    const key = `${step.nodeId}@${fork.instance}`;
    const entry = joins.get(key) ?? { arrived: new Set<number>(), fired: false };
    joins.set(key, entry);
    if (entry.fired) return false;
    entry.arrived.add(fork.index);
    const iteration = iterationOf(token, step.loopId);
    if (step.policy === 'all') {
      if (entry.arrived.size < gathers.width) return false;
      entry.fired = true;
      await guarded(token).joined(step.nodeId, iteration, [], []);
    } else {
      entry.fired = true;
      const stopped: StepRef[] = [];
      const loops = new Map<string, number>();
      for (const other of live) {
        const theirs = other.forks.find((f) => f.instance === fork.instance);
        if (other === token || !theirs || theirs.index === fork.index) continue;
        other.stopped = true;
        if (other.current) stopped.push(other.current);
        for (const [loopId, no] of Object.entries(other.rounds))
          if (!theirs.loops.includes(loopId)) loops.set(loopId, no);
      }
      // Innermost first: a Loop inside another ends before it.
      const ordered = [...loops].sort(
        ([a], [b]) => Number(inside(plan, b, a)) - Number(inside(plan, a, b)),
      );
      await guarded(token).joined(
        step.nodeId,
        iteration,
        stopped,
        ordered.map(([loopId, no]) => ({ loopId, no })),
      );
    }
    token.forks = token.forks.slice(0, -1);
    return true;
  };

  const walk = async (token: Token) => {
    for (;;) {
      if (token.stopped || result || failure) return;
      if (signal?.aborted) return finish({ kind: 'stopped' });
      const step: PlanStep | undefined = plan.steps[token.target.nodeId];
      if (!step) throw new Error(`plan has no step ${token.target.nodeId}`);
      if (step.kind === 'join' && step.gathers) {
        if (!(await arrive(token, step))) return;
        advance(token, step.next, `${step.nodeId}\u0000out`);
        continue;
      }
      token.current = { nodeId: step.nodeId, iteration: iterationOf(token, step.loopId) };
      const outcome = await executeStep(
        plan,
        step,
        token.target.port,
        token.rounds,
        guarded(token),
      );
      token.current = null;
      if (token.stopped || result || failure) return;
      // A step that settles after a stop must not start the next one.
      if (signal?.aborted) return finish({ kind: 'stopped' });
      if ('end' in outcome) return finish(outcome.end);
      advance(token, outcome.next, outcome.port);
    }
  };

  spawn({ target: entryTarget(plan), rounds: {}, forks: [], current: null, stopped: false });
  await done;
  if (failure) throw (failure as { error: unknown }).error;
  if (!result) throw new Error('every branch stopped without ending the run');
  return result;
}

/**
 * Reference runner: the branch walker over the IR. It defines the expected order for runner
 * parity tests and runs where LangGraph is not wanted.
 */
export class SequentialPlanRunner implements GraphRunner {
  run(plan: CompiledPlan, callbacks: RunnerCallbacks, signal?: StopSignal): Promise<RunnerResult> {
    return walkPlan(plan, callbacks, signal);
  }
}
