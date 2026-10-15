// C-052 LangGraph spike: static control flow whose nodes only ask the Coordinator to act.
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

// Fake Coordinator: activation keys make node re-entry idempotent (Technical-Design §4.2).
const coordinator = {
  tasks: new Map(),
  requests: [],
  async requestExecution(runId, nodeId, iterationId) {
    const key = `${runId}:${nodeId}:${iterationId}`;
    this.requests.push(key);
    if (!this.tasks.has(key)) this.tasks.set(key, { key, verdict: null });
    return this.tasks.get(key);
  },
};

const State = Annotation.Root({
  runId: Annotation(),
  iteration: Annotation({ reducer: (_a, b) => b, default: () => 1 }),
  verdicts: Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
});

const verdictFor = (iteration) => (iteration === 1 ? 'revise' : 'pass');
let throwOnce = true;
const graph = new StateGraph(State)
  .addNode('research', async (s) => {
    await coordinator.requestExecution(s.runId, 'research', 'none');
    return {};
  })
  .addNode('write', async (s) => {
    await coordinator.requestExecution(s.runId, 'write', `it${s.iteration}`);
    return {};
  })
  .addNode('review', async (s) => {
    const task = await coordinator.requestExecution(s.runId, 'review', `it${s.iteration}`);
    task.verdict = verdictFor(s.iteration);
    return { verdicts: [task.verdict] };
  })
  .addNode('next_iteration', async (s) => ({ iteration: s.iteration + 1 }))
  .addEdge(START, 'research')
  .addEdge('research', 'write')
  .addEdge('write', 'review')
  .addConditionalEdges('review', (s) => {
    const last = s.verdicts.at(-1);
    if (last === 'revise' && s.iteration < 2) return 'next_iteration';
    return 'done';
  }, { next_iteration: 'next_iteration', done: END })
  .addEdge('next_iteration', 'write');

const app = graph.compile(); // no checkpointer: the Coordinator owns durable state (ADR-004)
const result = {};
const final = await app.invoke({ runId: 'run_1' });
result.requests = coordinator.requests;
result.verdicts = final.verdicts;
result.iterations = final.iteration;

// Duplicate activation of the same node/iteration does not create a second task.
const before = coordinator.tasks.size;
await coordinator.requestExecution('run_1', 'write', 'it1');
result.duplicateActivationCreatedTask = coordinator.tasks.size !== before;

// Default retry behaviour: a throwing node fails the invoke (no silent retry).
const flakyNode = async () => {
  if (throwOnce) {
    throwOnce = false;
    throw new Error('transient failure');
  }
  return {};
};
const flaky = new StateGraph(State).addNode('flaky', flakyNode).addEdge(START, 'flaky').addEdge('flaky', END).compile();
try {
  await flaky.invoke({ runId: 'run_2' });
  result.defaultRetry = 'node was retried and succeeded';
} catch (error) {
  result.defaultRetry = `no retry: ${error.message}`;
}

// recursionLimit bounds runaway loops independently of Corral's own caps.
result.defaultRecursionLimit = app.config?.recursionLimit ?? 'library default';
console.log(JSON.stringify(result, null, 2));
