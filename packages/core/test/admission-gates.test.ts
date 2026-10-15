import type { RunEvent } from '@corral/contracts';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  type AdmissionGates,
  type AdmissionObserver,
  type AdmissionStage,
  Coordinator,
  canonicalJson,
  DEFAULT_GATES,
  type Gate,
  InProcessTransport,
  type RunProjection,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

// Admission gates and observers (CR-003, C-067, ADR-024, CRL-RUN-008).

const terminal = (p: RunProjection) =>
  ['succeeded', 'failed', 'cancelled'].includes(p.status) && p.lastSeq > 0;

async function drain() {
  for (let i = 0; i < 300; i++) await Promise.resolve();
}

async function runLinear(
  admission: { gates?: Partial<AdmissionGates>; observers?: AdmissionObserver[] } = {},
  options: Partial<ScriptedAgentOptions> = {},
) {
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 2, ...options }),
    policy: SPEC_HARD_CAPS,
    admission,
  });
  const transport = new InProcessTransport(coordinator);
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_start',
    definition: linearCorral(['writer']),
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
  const final = await waitForProjection(transport, runId, terminal);
  await drain();
  return { events, final };
}

/** A gate that records each call and lets everything through. */
function spy(id: string, calls: string[]): Gate<never> {
  return {
    id,
    version: 1,
    check: () => {
      calls.push(id);
      return { kind: 'allow' };
    },
  };
}

const withExtra = (stage: AdmissionStage, ...extra: Gate<never>[]): Partial<AdmissionGates> => ({
  [stage]: [...(DEFAULT_GATES[stage] as Gate<never>[]), ...extra],
});

describe('admission gates (C-067)', () => {
  it('[TC-RUN-008-H] each stage runs its gates in registration order, at its own point of the request', async () => {
    const calls: string[] = [];
    const stages: AdmissionStage[] = [
      'model.request',
      'model.admit',
      'tool.pre_boundary',
      'tool.authorize',
      'tool.execute',
    ];
    const gates = Object.fromEntries(
      stages.map((stage) => [
        stage,
        [
          ...(DEFAULT_GATES[stage] as Gate<never>[]),
          spy(`${stage}#a`, calls),
          spy(`${stage}#b`, calls),
        ],
      ]),
    ) as Partial<AdmissionGates>;
    const { final } = await runLinear({ gates });
    expect(final.status).toBe('succeeded');
    // Two model requests, then write_artifact and submit_result.
    const request = ['model.request#a', 'model.request#b', 'model.admit#a', 'model.admit#b'];
    const tool = [
      'tool.pre_boundary#a',
      'tool.pre_boundary#b',
      'tool.authorize#a',
      'tool.authorize#b',
      'tool.execute#a',
      'tool.execute#b',
    ];
    expect(calls).toEqual([...request, ...request, ...tool, ...tool]);
  });

  it('[TC-RUN-008-H] the default gates are named and versioned', () => {
    const named = Object.entries(DEFAULT_GATES).map(([stage, list]) => [
      stage,
      (list as Gate<never>[]).map((g) => `${g.id}@${g.version}`),
    ]);
    expect(Object.fromEntries(named)).toEqual({
      'model.request': ['no_progress@1'],
      'model.admit': ['budget@1'],
      'tool.pre_boundary': ['question_open@1'],
      'tool.authorize': ['role_allowlist@1', 'limits@1'],
      'tool.execute': ['role_allowlist@1', 'limits@1'],
    });
  });

  it('[TC-RUN-008-N] a tool gate that throws refuses the call with POLICY_ERROR, and nothing runs', async () => {
    const broken: Gate<never> = {
      id: 'broken',
      version: 1,
      check: () => {
        throw new Error('bug in policy');
      },
    };
    const { events } = await runLinear({ gates: withExtra('tool.authorize', broken) });
    const blocked = events.filter((e) => e.type === 'tool.blocked');
    expect(blocked.length).toBeGreaterThan(0);
    for (const e of blocked) {
      expect(e.type === 'tool.blocked' && e.payload.reason).toBe(
        'POLICY_ERROR: policy check broken@1 failed',
      );
    }
    expect(events.some((e) => e.type === 'tool.allowed')).toBe(false);
    expect(events.some((e) => e.type === 'effect.admitted' && e.payload.kind === 'tool')).toBe(
      false,
    );
  });

  it('[TC-RUN-008-N] a model gate that throws admits no request and ends the execution, not the process', async () => {
    const broken: Gate<never> = {
      id: 'broken',
      version: 1,
      check: () => {
        throw new Error('bug in policy');
      },
    };
    const { events, final } = await runLinear({ gates: withExtra('model.admit', broken) });
    expect(events.some((e) => e.type === 'budget.reserved')).toBe(false);
    expect(events.some((e) => e.type === 'model.request_prepared')).toBe(false);
    expect(final.status).toBe('failed');
    const [execution] = Object.values(final.executions);
    expect(execution?.error).toContain('POLICY_ERROR');
  });

  it('[TC-RUN-008-N] the first refusal stops the stage: later gates do not run', async () => {
    const calls: string[] = [];
    const refuse: Gate<never> = {
      id: 'refuse_writes',
      version: 1,
      check: () => ({ kind: 'refuse', code: 'CAPABILITY_DENIED', message: 'no writes today' }),
    };
    const { events } = await runLinear({
      gates: withExtra('tool.authorize', refuse, spy('after', calls)),
    });
    expect(calls).toEqual([]);
    const blocked = events.find((e) => e.type === 'tool.blocked');
    expect(blocked?.type === 'tool.blocked' && blocked.payload.reason).toBe(
      'CAPABILITY_DENIED: no writes today',
    );
  });

  it('[TC-RUN-008-N] a gate cannot change what it is shown; trying to is a policy error', async () => {
    const meddling: Gate<never> = {
      id: 'meddling',
      version: 1,
      check: (view) => {
        (view as { projection: { status: string } }).projection.status = 'succeeded';
        return { kind: 'allow' };
      },
    };
    const { events, final } = await runLinear({ gates: withExtra('model.admit', meddling) });
    expect(final.status).toBe('failed');
    expect(Object.values(final.executions)[0]?.error).toContain('POLICY_ERROR');
    // The run only reached its end through committed events, never through the gate.
    expect(events.filter((e) => e.type === 'run.state_changed').map((e) => e.payload.to)).toEqual(
      expect.not.arrayContaining(['succeeded']),
    );
  });
});

describe('admission observers (C-067)', () => {
  const lines = (events: RunEvent[]) => events.map((e) => canonicalJson(e));

  it('[TC-RUN-008-N] observers that throw, reject or try to change state leave the event stream as it was', async () => {
    const baseline = lines((await runLinear()).events);
    const seen: string[] = [];
    const observers: AdmissionObserver[] = [
      {
        id: 'throws',
        version: 1,
        on: 'model.prepared',
        handle: () => {
          throw new Error('observer bug');
        },
      },
      {
        id: 'rejects',
        version: 1,
        on: 'tool.finished',
        handle: async () => {
          throw new Error('observer bug');
        },
      },
      {
        id: 'meddles',
        version: 1,
        on: 'model.finished',
        handle: (view) => {
          seen.push(view.event.type);
          (view as { projection: { status: string } }).projection.status = 'cancelled';
        },
      },
    ];
    const { events, final } = await runLinear({ observers });
    expect(final.status).toBe('succeeded');
    expect(lines(events)).toEqual(baseline);
    expect(seen).toEqual(['model.finished', 'model.finished']);
  });

  it('[TC-RUN-008-H] an observer runs after the commit and sees the committed request', async () => {
    const seen: { type: string; prepared: boolean }[] = [];
    const observer: AdmissionObserver = {
      id: 'watch',
      version: 1,
      on: 'model.prepared',
      handle: (view) => {
        const id =
          view.event.type === 'model.request_prepared' ? view.event.payload.modelCallId : '';
        seen.push({ type: view.event.type, prepared: Boolean(view.projection.modelCalls[id]) });
      },
    };
    await runLinear({ observers: [observer] });
    expect(seen).toEqual([
      { type: 'model.request_prepared', prepared: true },
      { type: 'model.request_prepared', prepared: true },
    ]);
  });
});
