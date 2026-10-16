import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import { Coordinator, InProcessTransport, waitForProjection } from '../src/index.ts';

// Roadmap 16: a run's start and end come from its own committed events.

it('[TC-OBS-004-H] records when the run started and when it ended; a running run has no end', async () => {
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    clock,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  const transport = new InProcessTransport(coordinator);
  const { runId } = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd',
    definition: linearCorral(['writer']),
    mode: 'mock',
  });
  const started = coordinator.getSnapshot(runId ?? '').projection;
  expect(started.startedAt).toBe(clock.nowIso());
  expect(started.endedAt).toBeNull();
  const final = await waitForProjection(transport, runId ?? '', (p) => p.status === 'succeeded');
  expect(final.startedAt).toBe(started.startedAt);
  expect(final.endedAt).not.toBeNull();
});
