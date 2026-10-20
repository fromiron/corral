import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import {
  Coordinator,
  InProcessTransport,
  importMarkdownAgent,
  parseMarkdownAgent,
  waitForProjection,
} from '../src/index.ts';

it('[TC-ABS-011-H] the product simulated agent answers imported children and resumes their wait', async () => {
  const parent = linearCorral(['parent']);
  const imported = importMarkdownAgent({
    draft: { definition: parent, layout: {} },
    candidate: parseMarkdownAgent(
      '---\nname: helper\ndescription: Inspect supplied input\ntools: []\n---\nReport evidence.',
    ),
    parentNodeId: 'parent',
    modelProfile: 'model-a',
    profiles: [{ profileId: 'model-a', available: true }],
    mappings: {},
    suffix: 'simulated',
  });
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  const transport = new InProcessTransport(coordinator);
  const started = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'start_imported_simulated',
    definition: imported.definition,
    mode: 'mock',
  });
  if (!started.runId) throw new Error(JSON.stringify(started.receipt.error));
  const final = await waitForProjection(transport, started.runId, (state) =>
    ['succeeded', 'failed', 'cancelled'].includes(state.status),
  );
  expect(final.status).toBe('succeeded');
  expect(Object.values(final.executions)).toHaveLength(3);
  expect(Object.values(final.questions)).toHaveLength(2);
  expect(Object.values(final.questions).every((question) => question.status === 'answered')).toBe(
    true,
  );
  const children = Object.values(final.tasks).filter((task) => task.nodeId === 'import_simulated');
  expect(children).toHaveLength(2);
  expect(children.every((task) => task.status === 'completed')).toBe(true);
});
