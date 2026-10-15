import {
  type CompiledPlan,
  executeStep,
  type GraphRunner,
  type PlanTarget,
  type RunnerCallbacks,
  type RunnerResult,
  type StopSignal,
  targetsOf,
} from '@corral/core';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';

// GraphRunner on LangGraph.js (ADR-004, C-014). The compiled plan becomes a static StateGraph:
// one graph node per step, with conditional edges to exactly the targets that step can reach.
// No checkpointer, no interrupts and no retries: the Coordinator owns every durable fact, and
// each graph node only asks it to act through the callbacks (Technical-Design §4.3).
// `/web` keeps the runner usable in the browser runtime as well (ADR-016).

const State = Annotation.Root({
  /** Where the walk goes next; null once the run has ended. */
  target: Annotation<PlanTarget | null>({ reducer: (_old, next) => next, default: () => null }),
  /** Current round per Loop node. */
  rounds: Annotation<Record<string, number>>({
    reducer: (_old, next) => next,
    default: () => ({}),
  }),
  result: Annotation<RunnerResult | null>({ reducer: (_old, next) => next, default: () => null }),
});

export class LangGraphRunner implements GraphRunner {
  async run(
    plan: CompiledPlan,
    callbacks: RunnerCallbacks,
    signal?: StopSignal,
  ): Promise<RunnerResult> {
    // Graph node names are generated, so no step id can collide with LangGraph's own names.
    const names = new Map(Object.keys(plan.steps).map((id, i) => [id, `step_${i}`]));
    const nameOf = (nodeId: string) => {
      const name = names.get(nodeId);
      if (!name) throw new Error(`plan has no step ${nodeId}`);
      return name;
    };

    // The graph type changes with every added node; build it untyped and keep `State` checks.
    // biome-ignore lint/suspicious/noExplicitAny: LangGraph's builder type grows per node name.
    let graph: any = new StateGraph(State);
    for (const [nodeId, step] of Object.entries(plan.steps)) {
      graph = graph.addNode(nameOf(nodeId), async (state: typeof State.State) => {
        if (signal?.aborted) return { target: null, result: { kind: 'stopped' } };
        const rounds = { ...state.rounds };
        const port = state.target?.port ?? 'in';
        const outcome = await executeStep(step, port, rounds, callbacks);
        if (signal?.aborted) return { target: null, rounds, result: { kind: 'stopped' } };
        return 'end' in outcome
          ? { target: null, rounds, result: outcome.end }
          : { target: outcome.next, rounds, result: null };
      });
    }
    graph = graph.addEdge(START, nameOf(plan.entryNodeId));
    for (const [nodeId, step] of Object.entries(plan.steps)) {
      const reachable = [...new Set(targetsOf(step).map((t) => nameOf(t.nodeId)))];
      const paths = Object.fromEntries([...reachable.map((n) => [n, n]), [END, END]]);
      graph = graph.addConditionalEdges(
        nameOf(nodeId),
        (state: typeof State.State) => (state.target ? nameOf(state.target.nodeId) : END),
        paths,
      );
    }

    const app = graph.compile();
    const maxRounds = Math.max(1, ...Object.values(plan.loops).map((l) => l.maxIterations));
    const final = (await app.invoke(
      { target: { nodeId: plan.entryNodeId, port: 'in' }, rounds: {}, result: null },
      // Each round can visit every step once; leave room for the steps around the Loop.
      { recursionLimit: Object.keys(plan.steps).length * (maxRounds + 1) + 10 },
    )) as typeof State.State;
    if (!final.result) throw new Error('the graph ended without a result');
    return final.result;
  }
}
