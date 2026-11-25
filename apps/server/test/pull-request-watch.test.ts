import type { NewSessionEntry, SessionResult, WorkSession } from '@corral/core';
import { openDatabase, SqliteCorralRepository } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { PullRequestWatcher, type WatchedPr } from '../src/pull-requests/watch.ts';

// docs/specs/features/pull-requests.md 감시·깨우기·확인 필요, with a real store and fake timers.

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const START = { choice: { modelProfile: 'model-a' }, mode: 'mock' } as const;

function pr(overrides: Partial<WatchedPr> = {}): WatchedPr {
  return {
    number: 12,
    url: 'https://github.com/acme/widgets/pull/12',
    state: 'OPEN',
    headRefOid: HEAD_A,
    statusCheckRollup: [],
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    comments: [],
    reviews: [],
    ...overrides,
  };
}
const failing = (...names: string[]) =>
  names.map((name) => ({
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: `https://ci/${name}`,
  }));

async function setup(options: { started?: boolean; failSave?: () => boolean } = {}) {
  const db = openDatabase(':memory:');
  const repository = new SqliteCorralRepository(db, {
    clock: new FakeClock(),
    newCorralId: () => 'corral_x',
  });
  const created = await repository.createSession({ projectId: 'default', title: 'Login fix' });
  if (!created.ok) throw new Error(created.message);
  const sessionId = created.session.sessionId;
  if (options.started !== false) {
    const first = await repository.addSessionEntry(sessionId, {
      intent: 'next',
      state: 'started',
      text: 'Fix the login check',
      start: START as unknown as NewSessionEntry['start'],
    } as NewSessionEntry);
    if (!first.ok) throw new Error(first.message);
  }
  let current = pr();
  const timers: (() => void)[] = [];
  const queued = vi.fn();
  const watcher: PullRequestWatcher = new PullRequestWatcher({
    db,
    now: () => '2026-11-25T00:00:00.000Z',
    timers: {
      after: (_ms, fn) => {
        timers.push(fn);
        return () => {
          const at = timers.indexOf(fn);
          if (at >= 0) timers.splice(at, 1);
        };
      },
      turn: async () => {},
    },
    getSession: (id) => repository.getSession(id),
    addEntry: (id, entry): Promise<SessionResult> =>
      options.failSave?.()
        ? Promise.resolve({ ok: false, error: 'storage_unavailable', message: 'disk' })
        : repository.addSessionEntry(id, entry),
    dismissEntry: async (id, entryId) => {
      await repository.updateSessionEntry(id, entryId, { state: 'dismissed' });
    },
    read: (id) =>
      watcher.observe(id, { branch: 'corral/login-fix', base: 'main' }, [current], 'server'),
    queued,
  });
  const sweep = async () => {
    const fire = timers.shift();
    expect(fire, 'a sweep is armed').toBeDefined();
    fire?.();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const wakes = async () =>
    ((await repository.getSession(sessionId)) as WorkSession).entries.filter(
      (entry) => entry.pullRequest,
    );
  return {
    db,
    repository,
    sessionId,
    watcher,
    queued,
    timers,
    sweep,
    wakes,
    set: (next: WatchedPr) => {
      current = next;
    },
    screen: (next: WatchedPr) =>
      watcher.observe(sessionId, { branch: 'corral/login-fix', base: 'main' }, [next], 'screen'),
  };
}

it('arms no sweep while nothing is watched', async () => {
  const f = await setup();
  f.watcher.resume();
  expect(f.timers).toHaveLength(0);
});

it('takes a failure already there as a baseline, then wakes once for a new one', async () => {
  const f = await setup();
  f.set(pr({ statusCheckRollup: failing('lint') }));
  await f.watcher.onRunEnded(f.sessionId);
  expect(await f.wakes()).toEqual([]);
  f.set(pr({ statusCheckRollup: failing('lint', 'test') }));
  await f.sweep();
  const [wake] = await f.wakes();
  expect(wake).toMatchObject({
    intent: 'queue',
    state: 'queued',
    pullRequest: { number: 12, headSha: HEAD_A },
    start: START,
  });
  expect(wake?.text).toContain('  - test https://ci/test');
  expect(wake?.text).not.toContain('  - lint');
  expect(f.queued).toHaveBeenCalledWith(f.sessionId);
  await f.sweep();
  expect(await f.wakes()).toHaveLength(1);
});

it('keeps one unstarted wake, and removes it when the head moves', async () => {
  const f = await setup();
  await f.watcher.onRunEnded(f.sessionId);
  f.set(pr({ statusCheckRollup: failing('test') }));
  await f.sweep();
  f.set(pr({ statusCheckRollup: failing('test'), mergeable: 'CONFLICTING' }));
  await f.sweep();
  expect((await f.wakes()).filter((wake) => wake.state === 'queued')).toHaveLength(1);
  f.set(pr({ headRefOid: HEAD_B, statusCheckRollup: [] }));
  await f.sweep();
  expect((await f.wakes()).map((wake) => wake.state)).toEqual(['dismissed']);
});

it('stops after three wakes in a row and asks the person, until the person sends a request', async () => {
  const f = await setup();
  await f.watcher.onRunEnded(f.sessionId);
  const heads = ['1', '2', '3', '4'].map((digit) => digit.repeat(40));
  for (const head of heads) {
    f.set(pr({ headRefOid: head, statusCheckRollup: failing('test') }));
    await f.sweep();
    for (const wake of await f.wakes())
      if (wake.state === 'queued')
        await f.repository.updateSessionEntry(f.sessionId, wake.entryId, { state: 'started' });
  }
  expect(await f.wakes()).toHaveLength(3);
  const session = (await f.repository.getSession(f.sessionId)) as WorkSession;
  expect(f.watcher.inboxItems([session])).toEqual([
    expect.objectContaining({ kind: 'pull_request', detail: '#12 wakes_stopped' }),
  ]);
  f.watcher.onPersonRequest(f.sessionId);
  expect(f.watcher.inboxItems([session])).toEqual([]);
  f.set(pr({ headRefOid: '5'.repeat(40), statusCheckRollup: failing('test') }));
  await f.sweep();
  expect(await f.wakes()).toHaveLength(4);
});

it('moves on only once the wake is saved', async () => {
  let failing_ = true;
  const f = await setup({ failSave: () => failing_ });
  await f.watcher.onRunEnded(f.sessionId);
  f.set(pr({ statusCheckRollup: failing('test') }));
  await f.sweep();
  expect(await f.wakes()).toEqual([]);
  failing_ = false;
  await f.sweep();
  expect(await f.wakes()).toHaveLength(1);
});

it('asks the person when no request left a start choice to wake with', async () => {
  const f = await setup({ started: false });
  await f.watcher.onRunEnded(f.sessionId);
  f.set(pr({ statusCheckRollup: failing('test') }));
  await f.sweep();
  expect(await f.wakes()).toEqual([]);
  const session = (await f.repository.getSession(f.sessionId)) as WorkSession;
  expect(f.watcher.inboxItems([session])).toEqual([
    expect.objectContaining({ detail: '#12 no_start' }),
  ]);
});

it('raises reviews and comments for the person, never for the agent, and a screen read clears them', async () => {
  const f = await setup();
  await f.watcher.onRunEnded(f.sessionId);
  f.set(pr({ reviewDecision: 'CHANGES_REQUESTED', comments: [{}] }));
  await f.sweep();
  expect(await f.wakes()).toEqual([]);
  const session = (await f.repository.getSession(f.sessionId)) as WorkSession;
  expect(f.watcher.inboxItems([session])).toEqual([
    expect.objectContaining({ detail: '#12 review' }),
  ]);
  await f.screen(pr({ reviewDecision: 'CHANGES_REQUESTED', comments: [{}] }));
  expect(f.watcher.inboxItems([session])).toEqual([]);
});

it('ends the watch when the PR closes', async () => {
  const f = await setup();
  await f.watcher.onRunEnded(f.sessionId);
  f.set(pr({ state: 'MERGED' }));
  await f.sweep();
  expect(f.timers).toHaveLength(0);
  const ended = f.db
    .prepare('SELECT ended_at FROM pull_request_watches WHERE session_id=?')
    .get(f.sessionId) as { ended_at: string | null };
  expect(ended.ended_at).not.toBeNull();
});

it('ends the watch, and drops its unstarted wake, once the session is archived', async () => {
  const f = await setup();
  await f.watcher.onRunEnded(f.sessionId);
  f.set(pr({ statusCheckRollup: failing('test') }));
  await f.sweep();
  expect((await f.wakes()).map((wake) => wake.state)).toEqual(['queued']);
  const session = (await f.repository.getSession(f.sessionId)) as WorkSession;
  const archived = await f.repository.updateSession(f.sessionId, {
    archived: true,
    expectedRevision: session.revision,
  });
  expect(archived.ok).toBe(true);
  await f.sweep();
  expect(f.timers).toHaveLength(0);
  const ended = f.db
    .prepare('SELECT ended_at FROM pull_request_watches WHERE session_id=?')
    .get(f.sessionId) as { ended_at: string | null };
  expect(ended.ended_at).not.toBeNull();
  expect((await f.wakes()).map((wake) => wake.state)).toEqual(['dismissed']);
});
