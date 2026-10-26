import { AgentRole, type RequestPermit } from '@corral/contracts';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { Coordinator, InProcessTransport, waitForProjection } from '../src/index.ts';

const definition = () => linearCorral(['writer']);
function setup() {
  const permits: RequestPermit[] = [];
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({
      turns: 1,
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
          provider: 'openai',
          modelId: 'gpt-6-luna',
          auth: 'oauth',
          reasoning: {
            levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
            providerDefault: true,
          },
        },
      }),
    },
  });
  return { coordinator, permits, transport: new InProcessTransport(coordinator) };
}

describe('role reasoning', () => {
  it('preserves absent policy and accepts a fixed policy', () => {
    const role = definition().roles[0]!;
    expect(AgentRole.parse(role)).not.toHaveProperty('reasoning');
    expect(
      AgentRole.safeParse({ ...role, reasoning: { mode: 'fixed', level: 'high' } }).success,
    ).toBe(true);
  });
  it('carries a role setting to the request permit', async () => {
    const s = setup();
    const team = definition();
    Object.assign(team.roles[0]!, { reasoning: { mode: 'fixed', level: 'high' } });
    const result = s.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'live',
      definition: team,
    });
    expect(result.receipt.status).not.toBe('rejected');
    expect(result.runId).not.toBeNull();
    if (!result.runId) return;
    await waitForProjection(s.transport, result.runId, (p) => p.status === 'succeeded');
    expect(s.permits[0]).toMatchObject({
      reasoning: { requested: { mode: 'fixed', level: 'high' }, resolved: 'high', source: 'fixed' },
    });
  });
  it('refuses auto without explicit workspace apply', () => {
    const s = setup();
    const team = definition();
    Object.assign(team.roles[0]!, { reasoning: { mode: 'auto' } });
    const result = s.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'live',
      definition: team,
    });
    expect(result.runId).toBeNull();
    expect(result.receipt.error?.message).toContain('apply');
  });
});

it('a run-only model and effort override leaves the saved role unchanged', async () => {
  const s = setup();
  const team = definition();
  team.roles[0]!.reasoning = { mode: 'fixed', level: 'low' };
  const result = s.coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'override',
    definition: team,
    mode: 'live',
    roleOverrides: {
      [team.roles[0]!.id]: { modelProfile: 'model-b', reasoning: { mode: 'fixed', level: 'max' } },
    },
  });
  if (!result.runId) throw new Error(result.receipt.error?.message);
  await waitForProjection(s.transport, result.runId, (p) => p.status === 'succeeded');
  expect(s.permits[0]).toMatchObject({
    profile: 'model-b',
    reasoning: { resolved: 'max', source: 'fixed' },
  });
  expect(team.roles[0]).toMatchObject({
    modelProfile: 'model-a',
    reasoning: { mode: 'fixed', level: 'low' },
  });
  expect(s.coordinator.getRunSnapshot(result.runId)?.definition.roles[0]).toMatchObject({
    modelProfile: 'model-b',
    reasoning: { mode: 'fixed', level: 'max' },
  });
});
