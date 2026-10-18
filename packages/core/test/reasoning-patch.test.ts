import type { AgentStartInput, RequestPermit } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import {
  Coordinator,
  exportRunArchive,
  InMemoryRunStore,
  InProcessTransport,
  openRunArchive,
  waitForProjection,
} from '../src/index.ts';

it('[TC-RSN-001-H] [TC-RSN-003-H] atomic model/effort patch applies to future executions and survives history replay', async () => {
  const first = new Gate(),
    release = new Gate();
  const inputs: AgentStartInput[] = [],
    permits: RequestPermit[] = [];
  const store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    store,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      beforeReply: async (_turn, input) => {
        inputs.push(input);
        if (input.nodeId === 'first') {
          first.open();
          await release.wait();
        }
      },
      reply: (_turn, _input, permit) => {
        permits.push(permit);
        return 'done';
      },
    }),
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: {
          profile,
          provider: 'openai-codex',
          modelId: profile === 'model-a' ? 'gpt-6-luna' : 'gpt-6.1-sol',
          auth: 'oauth',
          reasoning: { levels: ['low', 'medium', 'high'], providerDefault: true },
        },
      }),
    },
  });
  const team = linearCorral(['first', 'second']);
  for (const role of team.roles) role.reasoning = { mode: 'fixed', level: 'low' };
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition: team,
    mode: 'live',
  });
  if (!result.runId) throw new Error('start failed');
  await first.wait();
  for (const [index, nodeId] of ['first', 'second'].entries()) {
    expect(
      coordinator.submit({
        schemaVersion: '0.1',
        commandId: `patch-${nodeId}`,
        runId: result.runId,
        type: 'patch',
        expectedControlRevision: index,
        payload: {
          kind: 'node_future',
          nodeId,
          modelProfile: 'model-b',
          reasoning: { mode: 'fixed', level: 'high' },
        },
      }).status,
    ).toBe('applied');
  }
  expect(
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'unsupported',
      runId: result.runId,
      type: 'patch',
      expectedControlRevision: 2,
      payload: {
        kind: 'node_future',
        nodeId: 'second',
        reasoning: { mode: 'fixed', level: 'max' },
      },
    }).error?.message,
  ).toContain('not supported');
  release.open();
  await waitForProjection(
    new InProcessTransport(coordinator),
    result.runId,
    (p) => p.status === 'succeeded',
  );
  expect(inputs.map((i) => i.modelProfile)).toEqual(['model-a', 'model-b']);
  expect(permits.map((p) => p.reasoning?.resolved)).toEqual(['low', 'high']);
  const archive = openRunArchive(
    exportRunArchive(store, result.runId, { privateTranscript: true }),
  );
  expect(archive.visibility).toBe('private');
  expect(JSON.stringify(archive)).toContain('"resolved":"high"');
});
