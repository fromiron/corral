import {
  type AgentAdapter,
  type AgentHost,
  type AgentSettlement,
  type CorralDefinition,
  CorralDefinition as Definition,
  type RunCommand,
  type RunEvent,
} from '@corral/contracts';
import {
  collaborationCorral,
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  canonicalJson,
  InProcessTransport,
  type RunProjection,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';
// The recorded streams were made from this definition; the shipped example has moved on (#20).
import researchTeam from './fixtures/research-team.before-criteria-input.corral.json' with {
  type: 'json',
};

// Golden event streams for the admission refactor (CR-003, C-067, ADR-024). They were recorded
// from the Coordinator *before* its checks moved into gates, and the default gate set must
// reproduce them byte for byte. Each scenario passes through an admission point: model request
// admission (budget, no progress), tool authorization (role allowlist, limits), the closed
// question check that runs before the safe boundary, and tool execution.
//
// Re-recording is deliberate:
//   CORRAL_UPDATE_GOLDEN=1 pnpm exec vitest run --project core admission-golden -u
// Without CORRAL_UPDATE_GOLDEN a missing file fails instead of being written. Core stays
// runtime-neutral (ADR-014), so files are read through Vite and written by Vitest snapshots.

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, string>;
  }
}

const RECORDED = import.meta.glob('./golden/*.events.jsonl', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const terminal = (p: RunProjection) =>
  ['succeeded', 'failed', 'cancelled'].includes(p.status) && p.lastSeq > 0;
const pendingApproval = (p: RunProjection) =>
  p.status === 'awaiting_user'
    ? (Object.values(p.approvals).find((a) => a.status === 'pending') ?? null)
    : null;

async function drain() {
  for (let i = 0; i < 300; i++) await Promise.resolve();
}

function runtime(agents: AgentAdapter, clock = new FakeClock()) {
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents,
    policy: SPEC_HARD_CAPS,
  });
  return { coordinator, transport: new InProcessTransport(coordinator), clock };
}

function scripted(options: Partial<ScriptedAgentOptions> = {}) {
  return new ScriptedAgentAdapter({ turns: 1, ...options });
}

async function start(transport: InProcessTransport, definition: CorralDefinition) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_start',
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
  let n = 0;
  const send = (type: RunCommand['type'], payload: unknown, expectedControlRevision?: number) =>
    transport.sendCommand({
      schemaVersion: '0.1',
      commandId: `cmd_${type}_${++n}`,
      runId,
      type,
      payload,
      ...(expectedControlRevision === undefined ? {} : { expectedControlRevision }),
    } as RunCommand);
  return { runId, events, send };
}

/** Approves the next pending approval; returns false once the run ends without one. */
async function approveNext(transport: InProcessTransport, runId: string, send: Sender) {
  const p = await waitForProjection(
    transport,
    runId,
    (x) => pendingApproval(x) !== null || terminal(x),
  );
  const approval = pendingApproval(p);
  if (!approval) return false;
  const receipt = await send(
    'resolve_approval',
    {
      approvalId: approval.approvalId,
      decision: 'approve',
      subjectVersionId: approval.subjectVersionIds[0],
    },
    p.controlRevision,
  );
  // A refused approval would come back as pending again; fail instead of looping.
  if (receipt.status === 'rejected') throw new Error(JSON.stringify(receipt.error));
  await waitForProjection(
    transport,
    runId,
    (x) => x.approvals[approval.approvalId]?.status !== 'pending',
  );
  return true;
}

type Sender = Awaited<ReturnType<typeof start>>['send'];

/** A hand-driven agent for paths a script cannot reach (no progress). */
function manualAgents() {
  const hosts: AgentHost[] = [];
  const agents: AgentAdapter = {
    async start(_input, host) {
      hosts.push(host);
      let settle!: (result: AgentSettlement) => void;
      const done = new Promise<AgentSettlement>((resolve) => {
        settle = resolve;
      });
      return {
        cancel: async () => settle({ outcome: 'cancelled' }),
        waitForSettlement: () => done,
      };
    },
  };
  return { agents, hosts };
}

const SCENARIOS: Record<string, () => Promise<RunEvent[]>> = {
  async 'linear-two-turns'() {
    const { transport } = runtime(scripted({ turns: 2 }));
    const { runId, events } = await start(transport, linearCorral(['writer']));
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },

  async collaboration() {
    const { transport } = runtime(scripted());
    const { runId, events } = await start(transport, collaborationCorral());
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },

  async 'review-loop-approvals'() {
    const { transport } = runtime(scripted());
    const { runId, events, send } = await start(transport, Definition.parse(researchTeam));
    while (await approveNext(transport, runId, send)) {}
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },

  async 'tool-outside-role-allowlist'() {
    // The writer may only write and submit; a search is refused before it runs.
    const { transport } = runtime(
      scripted({
        script: async (_input, host) => {
          await host.invokeTool({ name: 'search', args: { query: 'primary sources' } });
          return null;
        },
      }),
    );
    const { runId, events } = await start(transport, linearCorral(['writer']));
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },

  async 'spawn-limit'() {
    const definition = collaborationCorral();
    definition.limits = { ...definition.limits, maxSpawns: 1 };
    const { transport } = runtime(scripted());
    const { runId, events } = await start(transport, definition);
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },

  async 'model-call-limit'() {
    const definition = linearCorral(['writer']);
    definition.limits = { ...definition.limits, maxModelCalls: 1 };
    const { transport } = runtime(scripted({ turns: 2 }));
    const { runId, events } = await start(transport, definition);
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },

  async 'no-progress-approval'() {
    const { agents, hosts } = manualAgents();
    const { transport } = runtime(agents);
    const { runId, events, send } = await start(transport, linearCorral(['writer']));
    await drain();
    const host = hosts[0];
    if (!host) throw new Error('agent not started');
    for (let turn = 0; turn < 6; turn++) {
      const permit = await host.prepareModelRequest();
      await host.observe({
        kind: 'model_completed',
        modelCallId: permit.modelCallId,
        text: 'response',
        usage: { inputTokens: null, outputTokens: 1 },
      });
    }
    const seventh = host.prepareModelRequest().catch(() => null);
    if (!(await approveNext(transport, runId, send))) throw new Error('no approval');
    await seventh;
    await send('cancel', { scope: { kind: 'run' }, reason: 'end of scenario' });
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },

  async 'late-reply-after-timeout'() {
    const responder = new Gate();
    const { transport, clock } = runtime(
      scripted({
        script: async (input, host) => {
          if (input.assignment.kind !== 'question') return null;
          await responder.wait();
          await host.invokeTool({
            name: 'reply',
            args: { questionId: input.assignment.questionId, body: 'Too late.', evidenceRefs: [] },
          });
          return { outcome: 'succeeded' };
        },
      }),
    );
    const definition = collaborationCorral();
    const { runId, events } = await start(transport, definition);
    await waitForProjection(transport, runId, (p) =>
      Object.values(p.questions).some((q) => q.status === 'open'),
    );
    clock.advance(definition.limits.questionTimeoutMs);
    await drain();
    responder.open();
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },

  async 'steer-next-request'() {
    const gate = new Gate();
    const { transport } = runtime(scripted({ turns: 2, beforeReply: () => gate.wait() }));
    const { runId, events, send } = await start(transport, linearCorral(['writer']));
    const p = await waitForProjection(transport, runId, (x) => x.executionOrder.length > 0);
    while (gate.waiting === 0) await drain();
    await send('steer', {
      targetExecutionId: p.executionOrder[0],
      text: 'Use primary sources only.',
      delivery: 'next_request',
    });
    gate.open();
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },

  async 'cancel-during-request'() {
    const gate = new Gate();
    const { transport } = runtime(scripted({ turns: 2, beforeReply: () => gate.wait() }));
    const { runId, events, send } = await start(transport, linearCorral(['writer']));
    while (gate.waiting === 0) await drain();
    await send('cancel', { scope: { kind: 'run' }, reason: 'user stop' });
    gate.open();
    await waitForProjection(transport, runId, terminal);
    await drain();
    return events;
  },
};

/** The test runner's environment, without typing core against Node (ADR-014). */
const env = (name: string) =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];

const lines = (events: RunEvent[]) => events.map((e) => canonicalJson(e));

describe('admission golden event streams (C-067, ADR-024)', () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`[TC-RUN-008-H] ${name} keeps its recorded event stream`, async () => {
      const first = lines(await scenario());
      // The scenario must be deterministic before it can pin anything.
      expect(lines(await scenario())).toEqual(first);
      const file = `./golden/${name}.events.jsonl`;
      const recording = env('CORRAL_UPDATE_GOLDEN') === '1';
      if (!recording && !(file in RECORDED)) {
        throw new Error(
          `no golden for ${name}: record it deliberately with CORRAL_UPDATE_GOLDEN=1`,
        );
      }
      if (!recording) {
        // Line by line, so a failure shows which events changed.
        expect(first).toEqual((RECORDED[file] ?? '').trimEnd().split('\n'));
      }
      await expect(`${first.join('\n')}\n`).toMatchFileSnapshot(file);
    });
  }
});
