import type { AgentHost, ModelRequestRecord, ReasoningPolicy } from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { Coordinator, SPEC_HARD_CAPS } from '../src/index.ts';

// features/effort-routing.md: with the effort mode off, an automatic request asks no judge and
// goes with the provider default; fixed levels and the provider default are never judged.

const HASH = 'a'.repeat(64);
const compaction: ModelRequestRecord = {
  purpose: 'compaction',
  runtime: 'pi-core',
  directiveIds: [],
  contextHash: HASH,
  contextBytes: 0,
  sections: [],
};

async function setup(
  options: {
    reasoning?: ReasoningPolicy;
    providerDefault?: boolean;
    levels?: ('low' | 'medium' | 'high' | 'xhigh')[];
  } = {},
) {
  const clock = new FakeClock();
  const started = new Gate(),
    done = new Gate();
  let host!: AgentHost;
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    policy: SPEC_HARD_CAPS,
    agents: {
      start: async (_input, h) => {
        host = h;
        started.open();
        return {
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' };
          },
        };
      },
    },
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: {
          profile,
          provider: 'openai-codex',
          modelId: 'gpt-6-luna',
          auth: 'oauth',
          reasoning: {
            levels: options.levels ?? ['low', 'medium', 'high', 'xhigh'],
            providerDefault: options.providerDefault ?? true,
          },
        },
      }),
    },
  });
  const team = linearCorral(['writer']);
  team.roles[0]!.reasoning = options.reasoning ?? { mode: 'auto' };
  const start = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'live',
    definition: team,
  });
  return { coordinator, start, host: () => host, started, done };
}

describe('automatic reasoning with the effort mode off', () => {
  it('sends an automatic request with the provider default and no judgment', async () => {
    const s = await setup();
    expect(s.start.runId).not.toBeNull();
    await s.started.wait();
    const permit = await s.host().prepareModelRequest();
    expect(permit.reasoning).toEqual({
      requested: { mode: 'auto' },
      resolved: null,
      source: 'off',
      preparationId: expect.any(String),
    });
    s.done.open();
  });

  it('keeps the internal medium policy for an automatic compaction request', async () => {
    const s = await setup();
    await s.started.wait();
    const permit = await s.host().prepareModelRequest(compaction);
    expect(permit.reasoning).toMatchObject({ resolved: 'medium', source: 'internal-policy' });
    s.done.open();
  });

  it('leaves a fixed level and the provider default alone', async () => {
    for (const reasoning of [
      { mode: 'fixed', level: 'high' },
      { mode: 'provider_default' },
    ] satisfies ReasoningPolicy[]) {
      const s = await setup({ reasoning });
      await s.started.wait();
      const permit = await s.host().prepareModelRequest();
      expect(permit.reasoning).toMatchObject(
        reasoning.mode === 'fixed'
          ? { resolved: 'high', source: 'fixed' }
          : { resolved: null, source: 'provider_default' },
      );
      s.done.open();
    }
  });

  it('refuses automatic reasoning on a model without a verified provider default', async () => {
    const s = await setup({ providerDefault: false });
    expect(s.start.runId).toBeNull();
    expect(s.start.receipt.error?.message).toMatch(/automatic reasoning/);
  });
});
