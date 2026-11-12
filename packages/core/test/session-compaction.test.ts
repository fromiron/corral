import type { AgentStartInput, ModelProfileSnapshot, SessionCommand } from '@corral/contracts';
import { COMPACTION_SUMMARY_INSTRUCTION, COMPACTION_SYSTEM_INSTRUCTION } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

// Session compaction replaces the turns the next request would attach. The original
// run records stay. The model call is injected.

const SESSION = 'session_chat';
const MODEL: ModelProfileSnapshot = {
  profile: 'writer',
  provider: 'openai',
  modelId: 'gpt-test',
  auth: 'api_key',
};
const ended = (status: string) =>
  ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status);

type Complete = NonNullable<
  ConstructorParameters<typeof Coordinator>[0]['sessionCompaction']
>['complete'];

function setup(complete: Complete, options: { revision?: number; hold?: Gate } = {}) {
  const calls: Parameters<Complete>[0][] = [];
  const starts: AgentStartInput[] = [];
  let revision: number | null = options.revision ?? 4;
  const store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory('cmp'),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      appendNotes: false,
      reply: (_turn, input) => `Answer to: ${input.inputs.find((i) => i.name === 'brief')?.text}`,
      beforeReply: async (turn, input) => {
        if (turn === 1) starts.push(JSON.parse(JSON.stringify(input)) as AgentStartInput);
        if (input.inputs.some((item) => item.text === 'HOLD')) await options.hold?.wait();
      },
    }),
    models: {
      resolve: () => ({ ok: true, snapshot: MODEL }),
    },
    sessionFacts: {
      revision: () => revision,
      modelProfile: () => 'writer',
    },
    sessionCompaction: {
      complete: async (request, cancellation) => {
        calls.push(request);
        return complete(request, cancellation);
      },
    },
  });
  return {
    coordinator,
    transport: new InProcessTransport(coordinator),
    store,
    calls,
    starts,
    setRevision: (next: number | null) => {
      revision = next;
    },
  };
}

type Setup = ReturnType<typeof setup>;

function begin(s: Setup, commandId: string, brief: string, extra: Record<string, unknown> = {}) {
  const definition = linearCorral(['writer']);
  definition.input = { ...definition.input, brief };
  return s.coordinator.startRun({
    schemaVersion: '0.1',
    commandId,
    definition,
    mode: 'mock',
    sessionId: SESSION,
    ...extra,
  } as Parameters<Coordinator['startRun']>[0]);
}

async function turn(
  s: Setup,
  commandId: string,
  brief: string,
  extra: Record<string, unknown> = {},
) {
  const result = begin(s, commandId, brief, extra);
  if (!result.runId) return { result, projection: null, runId: '' };
  const projection = await waitForProjection(s.transport, result.runId, (p) => ended(p.status));
  return { result, projection, runId: result.runId };
}

const compact = (revision = 4): SessionCommand => ({
  schemaVersion: '0.1',
  type: 'compact_session',
  commandId: 'cmd_compact',
  sessionId: SESSION,
  expectedSessionRevision: revision,
});

async function settled(s: Setup, commandId = 'cmd_compact') {
  for (let i = 0; i < 20; i++) {
    const record = s.coordinator
      .sessionCompactions(SESSION)
      .find((item) => item.commandId === commandId);
    if (record) return record;
    await Promise.resolve();
  }
  throw new Error(`session compaction ${commandId} did not settle`);
}

describe('session compaction', () => {
  it('replaces attached turns with a smaller summary and keeps the original records', async () => {
    const s = setup(async () => ({ text: 'Goal: explain the sequence.', stopReason: 'stop' }));
    const first = await turn(
      s,
      'cmd_first',
      'Explain the fibonacci sequence with the constraints to preserve.',
    );
    const second = await turn(s, 'cmd_second', 'Now give a shorter version of that explanation.', {
      conversation: { throughRunId: first.runId },
    });
    const before = s.store.getConversationTurn(first.runId);
    const receipt = s.coordinator.submitSession(compact());
    const again = s.coordinator.submitSession(compact());
    expect(again).toEqual(receipt);
    expect(receipt.status).toBe('accepted');
    expect(receipt.error).toBeUndefined();
    const record = await settled(s);
    expect(record.phase).toBe('completed');
    expect(record.sessionRevision).toBe(4);
    expect(record.throughRunId).toBe(second.runId);
    expect(record.coveredRunIds).toEqual([first.runId, second.runId]);
    expect(record.summary).toBe('Goal: explain the sequence.');
    expect(
      s.coordinator.sessionCompactions(SESSION).filter((item) => item.commandId === 'cmd_compact'),
    ).toHaveLength(1);
    expect(s.store.getConversationTurn(first.runId)).toEqual(before);
    const third = await turn(s, 'cmd_third', 'Thanks.', {
      conversation: { throughRunId: second.runId },
    });
    const conversation = s.starts.find((input) => input.runId === third.runId)?.conversation;
    expect(conversation?.summary?.text).toBe('Goal: explain the sequence.');
    expect(conversation?.summary?.commandId).toBe('cmd_compact');
    expect(conversation?.turns).toEqual([]);
    const fourth = await turn(s, 'cmd_fourth', 'One more.', {
      conversation: { throughRunId: third.runId },
    });
    const later = s.starts.find((input) => input.runId === fourth.runId)?.conversation;
    expect(later?.summary?.text).toBe('Goal: explain the sequence.');
    expect(later?.turns.map((item) => item.request)).toEqual(['Thanks.']);
    const call = s.calls[0];
    expect(s.calls).toHaveLength(1);
    expect(call?.toolChoice).toBe('none');
    expect(call?.intent).toMatchObject({
      purpose: 'compaction',
      revision: 4,
      requestId: 'cmd_compact',
      owner: { kind: 'session', id: SESSION, sessionId: SESSION },
    });
    expect(
      call?.messages.some((message) => message.content === COMPACTION_SYSTEM_INSTRUCTION),
    ).toBe(true);
    expect(call?.messages.at(-1)?.content).toBe(COMPACTION_SUMMARY_INSTRUCTION);
    expect(call?.messages.map((message) => message.content).join('\n')).toContain(
      'Explain the fibonacci sequence',
    );
  });

  it('keeps the source when the summary fails or is not smaller', async () => {
    const s = setup(async () => {
      throw new Error('provider failed');
    });
    const first = await turn(s, 'cmd_first', 'Remember this request.');
    const receipt = s.coordinator.submitSession(compact());
    expect(receipt.status).toBe('accepted');
    const record = await settled(s);
    expect(record.phase).toBe('failed');
    expect(record.summary).toBeNull();
    const next = await turn(s, 'cmd_next', 'Continue.', {
      conversation: { throughRunId: first.runId },
    });
    const conversation = s.starts.find((input) => input.runId === next.runId)?.conversation;
    expect(conversation?.summary).toBeUndefined();
    expect(conversation?.turns.map((item) => item.request)).toEqual(['Remember this request.']);
    expect(s.calls).toHaveLength(1);

    const bulky = setup(async () => ({ text: 'x'.repeat(8_000), stopReason: 'stop' }));
    const short = await turn(bulky, 'cmd_short', 'Hi');
    const kept = bulky.coordinator.submitSession({ ...compact(), commandId: 'cmd_big' });
    expect(kept.status).toBe('accepted');
    expect((await settled(bulky, 'cmd_big')).phase).toBe('retained');
    const after = await turn(bulky, 'cmd_after', 'Next.', {
      conversation: { throughRunId: short.runId },
    });
    const body = bulky.starts.find((input) => input.runId === after.runId)?.conversation;
    expect(body?.summary).toBeUndefined();
    expect(body?.turns.map((item) => item.request)).toEqual(['Hi']);
  });

  it('discards a summary cancelled or returned for an older session revision', async () => {
    const gate = new Gate();
    const s = setup(async () => {
      await gate.wait();
      return { text: 'late summary', stopReason: 'stop' };
    });
    const first = await turn(s, 'cmd_first', 'Keep the original turns in the next request.');
    const accepted = s.coordinator.submitSession(compact());
    expect(accepted.status).toBe('accepted');
    for (let i = 0; i < 20 && s.calls.length === 0; i++) await Promise.resolve();
    expect(s.calls).toHaveLength(1);
    const cancel = s.coordinator.submitSession({
      schemaVersion: '0.1',
      type: 'cancel_session_compaction',
      commandId: 'cmd_cancel',
      sessionId: SESSION,
      targetCommandId: 'cmd_compact',
      expectedSessionRevision: 4,
    });
    expect(
      s.coordinator.submitSession({
        schemaVersion: '0.1',
        type: 'cancel_session_compaction',
        commandId: 'cmd_cancel',
        sessionId: SESSION,
        targetCommandId: 'cmd_compact',
        expectedSessionRevision: 4,
      }),
    ).toEqual(cancel);
    gate.open();
    expect((await settled(s)).phase).toBe('cancelled');
    const next = await turn(s, 'cmd_next', 'Still here.', {
      conversation: { throughRunId: first.runId },
    });
    const kept = s.starts.find((input) => input.runId === next.runId)?.conversation;
    expect(kept?.summary).toBeUndefined();
    expect(kept?.turns).toHaveLength(1);

    const lateGate = new Gate();
    const late = setup(async () => {
      await lateGate.wait();
      return { text: 'stale', stopReason: 'stop' };
    });
    const source = await turn(late, 'cmd_source', 'This turn stays because the revision moved.');
    late.coordinator.submitSession(compact());
    for (let i = 0; i < 20 && late.calls.length === 0; i++) await Promise.resolve();
    late.setRevision(5);
    lateGate.open();
    expect((await settled(late)).phase).toBe('discarded');
    const follow = await turn(late, 'cmd_follow', 'After.', {
      conversation: { throughRunId: source.runId },
    });
    const body = late.starts.find((input) => input.runId === follow.runId)?.conversation;
    expect(body?.summary).toBeUndefined();
    expect(body?.turns).toHaveLength(1);
  });

  it('refuses a different payload, an active run, and a second call for the same id', async () => {
    const gate = new Gate();
    const hold = new Gate();
    const s = setup(
      async () => {
        await gate.wait();
        return { text: 'summary', stopReason: 'stop' };
      },
      { hold },
    );
    await turn(s, 'cmd_first', 'One ended turn is enough to compact.');
    s.coordinator.submitSession(compact());
    const conflict = s.coordinator.submitSession({ ...compact(), expectedSessionRevision: 9 });
    expect(conflict.status).toBe('rejected');
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    const held = begin(s, 'cmd_hold', 'HOLD');
    expect(held.runId).toBeTruthy();
    const busy = s.coordinator.submitSession({ ...compact(), commandId: 'cmd_busy' });
    expect(busy.status).toBe('rejected');
    expect(busy.error?.code).toBe('RUN_ALREADY_ACTIVE');
    expect(s.calls).toHaveLength(1);
    gate.open();
    hold.open();
  });

  it('reports a pending, settled or unknown outcome for one command id', async () => {
    const gate = new Gate();
    const s = setup(async () => {
      await gate.wait();
      return { text: 'Goal.', stopReason: 'stop' };
    });
    await turn(s, 'cmd_first', 'A request long enough to summarize into something shorter.');
    expect(s.coordinator.sessionCompactionOutcome(SESSION, 'cmd_compact')).toBeNull();
    s.coordinator.submitSession(compact());
    expect(s.coordinator.sessionCompactionOutcome(SESSION, 'cmd_compact')).toEqual({
      commandId: 'cmd_compact',
      phase: 'pending',
    });
    expect(s.coordinator.sessionCompactionOutcome('session_other', 'cmd_compact')).toBeNull();
    gate.open();
    await settled(s);
    expect(s.coordinator.sessionCompactionOutcome(SESSION, 'cmd_compact')).toEqual({
      commandId: 'cmd_compact',
      phase: 'completed',
    });
    const refused = s.coordinator.submitSession({ ...compact(9), commandId: 'cmd_stale' });
    expect(refused.status).toBe('rejected');
    expect(s.coordinator.sessionCompactionOutcome(SESSION, 'cmd_stale')).toBeNull();
  });

  it('records nothing when the session is deleted before the summary returns', async () => {
    const gate = new Gate();
    const s = setup(async () => {
      await gate.wait();
      return { text: 'late summary', stopReason: 'stop' };
    });
    await turn(s, 'cmd_first', 'This session is deleted while its summary is in flight.');
    s.coordinator.submitSession(compact());
    for (let i = 0; i < 20 && s.calls.length === 0; i++) await Promise.resolve();
    s.setRevision(null);
    gate.open();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(s.coordinator.sessionCompactions(SESSION)).toEqual([]);
    expect(s.coordinator.sessionCompactionOutcome(SESSION, 'cmd_compact')).toBeNull();
  });
});
