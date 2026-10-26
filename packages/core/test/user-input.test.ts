import type { AgentHost, AgentStartInput } from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { Coordinator, exportRunArchive, InMemoryRunStore, openRunArchive } from '../src/index.ts';

const question = {
  key: 'delivery',
  timeoutMs: 1000,
  questions: [
    {
      id: 'format',
      kind: 'single',
      prompt: 'Private delivery question',
      options: [
        { id: 'short', label: 'Short', recommended: true },
        { id: 'long', label: 'Long' },
      ],
    },
    { id: 'note', kind: 'text', prompt: 'Private note' },
  ],
};

async function setup() {
  const started = new Gate(),
    done = new Gate(),
    clock = new FakeClock();
  const store = new InMemoryRunStore();
  let host!: AgentHost, input!: AgentStartInput;
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    store,
    ids: new SequentialIdFactory(),
    agents: {
      start: async (i, h) => {
        input = i;
        host = h;
        started.open();
        return {
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' as const };
          },
        };
      },
    },
  });
  const definition = linearCorral(['writer']);
  definition.roles[0]!.allowedCollaborationTools.push('ask_user');
  const start = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition,
    mode: 'mock',
  });
  expect(start.receipt.status).toBe('applied');
  await started.wait();
  const events = () => store.readEvents(input.runId, 0);
  const waiting = host.invokeTool({ name: 'ask_user', args: question });
  await vi.waitFor(() =>
    expect(events().some((e) => e.type === 'user_input.requested')).toBe(true),
  );
  const event = events().find((e) => e.type === 'user_input.requested');
  if (!event || event.type !== 'user_input.requested') throw new Error('missing request');
  const command = {
    schemaVersion: '0.1' as const,
    commandId: 'answer',
    runId: input.runId,
    type: 'answer_user' as const,
    expectedControlRevision: 0,
    payload: {
      requestId: event.payload.requestId,
      executionId: input.executionId,
      attemptNo: input.attemptNo,
      schemaHash: event.payload.schemaHash,
      answers: [
        { questionId: 'format', optionIds: ['short'] },
        { questionId: 'note', text: 'Private answer' },
      ],
    },
  };
  return { coordinator, store, clock, done, events, waiting, command, event, input };
}

it('user input is private and a matching answer resolves once, including after its reminder deadline', async () => {
  const s = await setup();
  try {
    expect(JSON.stringify(s.events())).not.toContain('Private delivery');
    s.clock.advance(1001);
    expect(s.coordinator.findSnapshot(s.input.runId)?.projection?.status).toBe('awaiting_user');
    expect(s.events().some((e) => e.type === 'user_input.answered')).toBe(false);
    for (const payload of [
      { ...s.command.payload, schemaHash: '0'.repeat(64) },
      { ...s.command.payload, attemptNo: 999 },
      { ...s.command.payload, answers: [{ questionId: 'format', optionIds: ['unknown'] }] },
    ])
      expect(
        s.coordinator.submit({
          ...s.command,
          commandId: `invalid_${payload.attemptNo}_${payload.schemaHash}_${payload.answers.length}`,
          payload,
        }).status,
      ).toBe('rejected');
    const receipt = s.coordinator.submit(s.command);
    expect(receipt.status).toBe('applied');
    expect(await s.waiting).toMatchObject({
      ok: true,
      result: { status: 'answered', answers: s.command.payload.answers },
    });
    expect(s.coordinator.submit(s.command)).toEqual(receipt);
    expect(s.coordinator.submit({ ...s.command, commandId: 'second_tab' }).status).toBe('rejected');
    expect(s.events().filter((e) => e.type === 'user_input.answered')).toHaveLength(1);
    expect(JSON.stringify(s.events())).not.toContain('Private answer');
    expect(() =>
      openRunArchive(exportRunArchive(s.store, s.input.runId, { privateTranscript: true })),
    ).not.toThrow();
  } finally {
    s.done.open();
  }
});

it('answering does not undo a user pause, and cancellation closes the owned question', async () => {
  const s = await setup();
  s.coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'pause',
    runId: s.input.runId,
    type: 'pause',
    payload: { scope: 'run' },
  });
  const revision = s.coordinator.findSnapshot(s.input.runId)?.projection.controlRevision;
  if (revision === undefined) throw new Error('missing revision');
  expect(s.coordinator.submit({ ...s.command, expectedControlRevision: revision }).status).toBe(
    'applied',
  );
  expect(await s.waiting).toMatchObject({ ok: true });
  expect(s.coordinator.findSnapshot(s.input.runId)?.projection?.status).toBe('paused');
  s.done.open();
  const c = await setup();
  c.coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'cancel',
    runId: c.input.runId,
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'cancel fixture' },
  });
  expect(await c.waiting).toMatchObject({ ok: true, result: { status: 'cancelled' } });
  expect(c.coordinator.submit(c.command).status).toBe('rejected');
  expect(c.events().filter((e) => e.type === 'user_input.closed')).toHaveLength(1);
});
