import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import { SPEC_HARD_CAPS } from '../src/config.ts';
import { Coordinator } from '../src/coordinator.ts';

it('[TC-LLM-002-H] [TC-LLM-002-F] auxiliary admission is bounded, cancellable and released once', async () => {
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    policy: { ...SPEC_HARD_CAPS, maxModelConcurrency: 1 },
  });
  const idle = { aborted: false, onCancel: () => () => {} };
  const first = await coordinator.acquireAuxiliaryModelSlot(idle);
  let abort = () => {};
  const waiting = coordinator.acquireAuxiliaryModelSlot({
    aborted: false,
    onCancel: (fn) => {
      abort = fn;
      return () => {};
    },
  });
  abort();
  await expect(waiting).rejects.toThrow();
  first();
  first();
  const next = await coordinator.acquireAuxiliaryModelSlot(idle);
  next();
});

it('[TC-LLM-002-N] a worker cooling down does not occupy the only host slot', async () => {
  const clock = new FakeClock(),
    entered = new Gate();
  let cooling = true,
    admitted = false;
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    policy: { ...SPEC_HARD_CAPS, maxModelConcurrency: 1 },
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: { profile, provider: null, modelId: null, auth: 'mock' },
      }),
      retryAfterMs: () => (cooling ? 1000 : 0),
    },
    agents: {
      start: async (_input, host) => {
        const work = (async () => {
          entered.open();
          const permit = await host.prepareModelRequest();
          admitted = true;
          await host.observe({
            kind: 'model_completed',
            modelCallId: permit.modelCallId,
            text: '',
            usage: { inputTokens: 0, outputTokens: 0 },
          });
          return { outcome: 'failed' as const };
        })();
        return { cancel: async () => {}, waitForSettlement: () => work };
      },
    },
  });
  coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'cooldown',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  await entered.wait();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(admitted).toBe(false);
  const release = await coordinator.acquireAuxiliaryModelSlot({
    aborted: false,
    onCancel: () => () => {},
  });
  release();
  cooling = false;
  clock.advance(1000);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(admitted).toBe(true);
});
