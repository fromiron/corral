import type { RunCommand } from '@corral/contracts';
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
  carriedDirectives,
  carriedEntry,
  createKeyValueCorralRepository,
  createTextAttachment,
  InMemoryRunStore,
  InProcessTransport,
  type KeyValueStore,
  nextQueuedEntry,
  queuedEntriesInStartOrder,
  type RunProjection,
  type SessionEntry,
  type SessionEntryStart,
  type WorkSession,
  waitForProjection,
} from '../src/index.ts';

// A user directive its target never read is carried into the session's queue only when the
// target succeeded (features/reins.md, "읽히지 못한 지시의 넘겨받기").

const later = (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown })
  .setTimeout;
const flush = () => new Promise<void>((resolve) => later(resolve, 20));
const ended = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

const ATTACHMENT = createTextAttachment('notes.txt', 'text/plain', 'attached words');

function setup(options: { fail?: boolean } = {}) {
  const gate = new Gate();
  const resolved: { runId: string; statuses: string[] }[] = [];
  const coordinator = new Coordinator({
    store: new InMemoryRunStore(),
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    onDirectivesExpired: (runId, projection) =>
      void resolved.push({
        runId,
        statuses: projection.directiveOrder.map((id) => projection.directives[id]?.status ?? ''),
      }),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      appendNotes: false,
      collaborate: false,
      beforeReply: () => gate.wait(),
      ...(options.fail
        ? {
            script: async () => {
              await gate.wait();
              return { outcome: 'failed' as const, error: 'the role gave up' };
            },
          }
        : {}),
    }),
  });
  const transport = new InProcessTransport(coordinator);
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'mock',
    definition: linearCorral(['research']),
  });
  const runId = started.runId ?? '';
  const send = (type: RunCommand['type'], payload: unknown, commandId: string) =>
    coordinator.submit({ schemaVersion: '0.1', runId, commandId, type, payload } as RunCommand);
  const steer = async (
    text: string,
    commandId: string,
    extra: { delivery?: 'next_request' | 'interrupt'; attachments?: unknown[] } = {},
  ) => {
    // After the only request was prepared, so nothing reads the directive any more.
    const p = await waitForProjection(
      transport,
      runId,
      (q) =>
        q.executionOrder.length === 1 &&
        (options.fail === true || Object.keys(q.modelCalls).length > 0),
    );
    return send(
      'steer',
      { targetExecutionId: p.executionOrder[0], text, delivery: 'next_request', ...extra },
      commandId,
    );
  };
  return { coordinator, transport, runId, gate, send, steer, resolved };
}

it('carries an unread user directive whose target succeeded, with its text and attachments', async () => {
  const s = setup();
  await s.steer('Also check the tests.', 'steer_one', { attachments: [ATTACHMENT] });
  s.gate.open();
  const projection = await waitForProjection(s.transport, s.runId, ended);
  expect(projection.status).toBe('succeeded');
  const [directiveId] = projection.directiveOrder;
  expect(projection.directives[directiveId ?? '']?.status).toBe('expired');
  expect(carriedDirectives(projection)).toEqual([
    { directiveId, text: 'Also check the tests.', attachments: [ATTACHMENT] },
  ]);
  // The record itself stays expired.
  expect(s.coordinator.getSnapshot(s.runId).projection.directives[directiveId ?? '']?.status).toBe(
    'expired',
  );
  await flush();
  // The host is told after the commit, with the committed projection.
  expect(s.resolved).toContainEqual({ runId: s.runId, statuses: ['expired'] });
});

it('carries an interrupt the target never read the same way', async () => {
  const s = setup();
  await s.steer('Stop and look here.', 'steer_cut', { delivery: 'interrupt' });
  s.gate.open();
  const projection = await waitForProjection(s.transport, s.runId, ended);
  expect(projection.status).toBe('succeeded');
  expect(carriedDirectives(projection).map((d) => d.text)).toEqual(['Stop and look here.']);
});

it('does not carry when the target failed', async () => {
  const s = setup({ fail: true });
  await s.steer('Too late for a failed role.', 'steer_failed');
  s.gate.open();
  const projection = await waitForProjection(s.transport, s.runId, ended);
  const [directiveId] = projection.directiveOrder;
  expect(projection.directives[directiveId ?? '']?.status).toBe('expired');
  expect(projection.executions[projection.executionOrder[0] ?? '']?.status).toBe('failed');
  expect(carriedDirectives(projection)).toEqual([]);
});

it('does not carry a directive a cancelled run left undelivered', async () => {
  const s = setup();
  await s.steer('Never mind.', 'steer_cancelled');
  s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel_run');
  s.gate.open();
  const projection = await waitForProjection(s.transport, s.runId, ended);
  expect(projection.status).toBe('cancelled');
  const [directiveId] = projection.directiveOrder;
  expect(projection.directives[directiveId ?? '']?.status).toBe('not_delivered');
  expect(carriedDirectives(projection)).toEqual([]);
  await flush();
  // Only an expiry is reported.
  expect(s.resolved).toEqual([]);
});

it('does not carry a directive from advice or the system', async () => {
  const s = setup();
  await s.steer('From the advisor.', 'steer_advice');
  s.gate.open();
  const projection = await waitForProjection(s.transport, s.runId, ended);
  const [directiveId] = projection.directiveOrder;
  const withOrigin = (origin: string) =>
    ({
      ...projection,
      directives: {
        [directiveId ?? '']: { ...projection.directives[directiveId ?? ''], origin },
      },
    }) as unknown as RunProjection;
  expect(carriedDirectives(withOrigin('advice'))).toEqual([]);
  expect(carriedDirectives(withOrigin('system'))).toEqual([]);
  expect(carriedDirectives(withOrigin('user'))).toHaveLength(1);
});

it('a directive already read is not carried', async () => {
  const gate = new Gate();
  const coordinator = new Coordinator({
    store: new InMemoryRunStore(),
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({
      turns: 2,
      appendNotes: false,
      collaborate: false,
      beforeReply: (turn) => (turn === 1 ? gate.wait() : Promise.resolve()),
    }),
  });
  const transport = new InProcessTransport(coordinator);
  const runId =
    coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'mock',
      definition: linearCorral(['research']),
    }).runId ?? '';
  const p = await waitForProjection(transport, runId, (q) => Object.keys(q.modelCalls).length > 0);
  coordinator.submit({
    schemaVersion: '0.1',
    runId,
    commandId: 'steer_read',
    type: 'steer',
    payload: { targetExecutionId: p.executionOrder[0], text: 'Read me.', delivery: 'next_request' },
  } as RunCommand);
  gate.open();
  const projection = await waitForProjection(transport, runId, ended);
  expect(Object.values(projection.directives).map((d) => d.status)).toEqual(['delivered']);
  expect(carriedDirectives(projection)).toEqual([]);
});

// Each directive is carried when it expires; those expiring together keep the send order.
it('carries each directive as it expires, in send order, without waiting for earlier ones', () => {
  const view = (id: string, status: string, target: string) => ({
    directiveId: id,
    targetExecutionId: target,
    text: `text ${id}`,
    status,
    commandId: null,
    acceptedSeq: 1,
    contextSnapshotId: null,
    modelCallId: null,
    reason: null,
  });
  const projection = (first: string) =>
    ({
      executions: {
        ex_a: { status: first === 'queued' ? 'active' : 'succeeded' },
        ex_b: { status: 'succeeded' },
      },
      directiveOrder: ['d1', 'd2', 'd3'],
      directives: {
        d1: view('d1', first, 'ex_a'),
        d2: view('d2', 'expired', 'ex_b'),
        d3: view('d3', 'expired', 'ex_b'),
      },
    }) as unknown as RunProjection;
  expect(carriedDirectives(projection('queued')).map((d) => d.directiveId)).toEqual(['d2', 'd3']);
  expect(carriedDirectives(projection('expired')).map((d) => d.directiveId)).toEqual([
    'd1',
    'd2',
    'd3',
  ]);
  expect(carriedDirectives(projection('delivered')).map((d) => d.directiveId)).toEqual([
    'd2',
    'd3',
  ]);
});

const START: SessionEntryStart = {
  choice: { modelProfile: 'model-a' },
  mode: 'mock',
  team: 'none',
  permissionMode: 'ask',
};
const entry = (entryId: string, extra: Partial<SessionEntry>): SessionEntry => ({
  entryId,
  intent: 'next',
  text: `text ${entryId}`,
  createdAt: 'x',
  state: 'started',
  runId: null,
  executionId: null,
  detail: null,
  ...extra,
});
const session = (entries: SessionEntry[]): WorkSession => ({
  sessionId: 's1',
  projectId: 'default',
  corralId: null,
  auto: null,
  title: 't',
  objective: '',
  pinned: false,
  revision: 1,
  createdAt: 'x',
  updatedAt: 'x',
  archivedAt: null,
  autoStart: true,
  entries,
});
const directive = { directiveId: 'dir_1', text: 'Read this after all.', attachments: [ATTACHMENT] };

it('a carried entry copies the start and permission of the request that started the run', () => {
  const started = entry('e1', { runId: 'run_1', start: START, permissionMode: 'ask' });
  expect(carriedEntry(session([started]), 'run_1', directive)).toEqual({
    intent: 'queue',
    state: 'queued',
    text: 'Read this after all.',
    attachments: [ATTACHMENT],
    start: START,
    permissionMode: 'ask',
    carriedFrom: 'dir_1',
  });
  // A queued request the server started counts the same.
  const queued = entry('e2', {
    intent: 'queue',
    runId: 'run_1',
    start: START,
    permissionMode: 'ask',
  });
  expect(carriedEntry(session([queued]), 'run_1', directive)?.start).toEqual(START);
});

it('no carried entry without the start of the request that started the run', () => {
  expect(carriedEntry(session([entry('e1', { runId: 'run_1' })]), 'run_1', directive)).toBeNull();
  expect(
    carriedEntry(session([entry('e1', { runId: 'run_other', start: START })]), 'run_1', directive),
  ).toBeNull();
  // A steer that went to the run did not start it.
  expect(
    carriedEntry(
      session([entry('e1', { intent: 'steer', runId: 'run_1', start: START })]),
      'run_1',
      directive,
    ),
  ).toBeNull();
});

it('a carried entry is the front of the queue, in the order carried', () => {
  const plain = entry('q1', { intent: 'queue', state: 'queued' });
  const carriedA = entry('q2', { intent: 'queue', state: 'queued', carriedFrom: 'dir_a' });
  const carriedB = entry('q3', { intent: 'queue', state: 'queued', carriedFrom: 'dir_b' });
  expect(nextQueuedEntry(session([plain, carriedA, carriedB]))?.entryId).toBe('q2');
  expect(nextQueuedEntry(session([plain]))?.entryId).toBe('q1');
  expect(nextQueuedEntry(session([{ ...carriedA, state: 'started' }, plain]))?.entryId).toBe('q1');
  const later = entry('q4', { intent: 'queue', state: 'queued' });
  expect(
    queuedEntriesInStartOrder(session([plain, carriedA, entry('s', {}), later, carriedB])).map(
      (e) => e.entryId,
    ),
  ).toEqual(['q2', 'q3', 'q1', 'q4']);
});

it('records one carried entry per directive, however often it is carried', async () => {
  const data = new Map<string, string>();
  const store: KeyValueStore = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
  const repo = createKeyValueCorralRepository(store, {
    clock: new FakeClock(),
    newCorralId: () => 'corral_x',
  });
  const created = await repo.createSession({ projectId: 'default', title: 'Carry' });
  if (!created.ok) throw new Error(created.message);
  const id = created.session.sessionId;
  const carried = {
    intent: 'queue' as const,
    state: 'queued' as const,
    text: 'Read this after all.',
    start: START,
    permissionMode: 'ask' as const,
    carriedFrom: 'dir_1',
  };
  const first = await repo.addSessionEntry(id, carried);
  const again = await repo.addSessionEntry(id, carried);
  expect(again).toMatchObject({ ok: true });
  expect(again.ok && again.session.entries).toEqual(first.ok && first.session.entries);
  expect((await repo.getSession(id))?.entries).toHaveLength(1);
});
