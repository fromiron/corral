import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, it } from 'vitest';

it('runs a static review loop in a real browser through the /web entry point', async () => {
  const State = Annotation.Root({
    iteration: Annotation({ reducer: (_a, b) => b, default: () => 1 }),
    visited: Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  });
  const app = new StateGraph(State)
    .addNode('write', async (s) => ({ visited: [`write:${s.iteration}`] }))
    .addNode('review', async (s) => ({ visited: [`review:${s.iteration}`] }))
    .addNode('next', async (s) => ({ iteration: s.iteration + 1 }))
    .addEdge(START, 'write')
    .addEdge('write', 'review')
    .addConditionalEdges('review', (s) => (s.iteration < 2 ? 'next' : 'done'), { next: 'next', done: END })
    .addEdge('next', 'write')
    .compile();
  const final = await app.invoke({});
  expect(typeof window).toBe('object');
  expect(final.visited).toEqual(['write:1', 'review:1', 'write:2', 'review:2']);
});
