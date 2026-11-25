import type { RunSummary, WorkSession } from '@corral/core';
import { expect, it } from 'vitest';
import { sessionGroups } from './sessionList.ts';
import { familyOrder } from './sessionOrder.ts';

// docs/specs/features/sub-sessions.md 목록: a family sits together, indented under its parent.

const session = (
  sessionId: string,
  updatedAt: string,
  parentSessionId: string | null = null,
  pinned = false,
) =>
  ({
    sessionId,
    projectId: 'alpha',
    entries: [{ entryId: 'e' }],
    archivedAt: null,
    updatedAt,
    pinned,
    parentSessionId,
  }) as unknown as WorkSession;
const run = (sessionId: string, status: RunSummary['status']): RunSummary => ({
  sessionId,
  projectId: 'alpha',
  corralId: 'team',
  runId: `${sessionId}:run`,
  status,
  startedAt: '2026-11-01T00:00:00Z',
});

it('orders families by their most recent member and puts each child under its parent', () => {
  const sessions = [
    session('lone', '2026-11-02'),
    session('parent', '2026-11-01'),
    session('child', '2026-11-03', 'parent'),
    session('grandchild', '2026-11-01', 'child'),
    session('older-child', '2026-11-01', 'parent'),
    session('orphan', '2026-11-04', 'gone'),
  ];
  expect(familyOrder(sessions).map(({ session, depth }) => [session.sessionId, depth])).toEqual([
    ['orphan', 0],
    ['parent', 0],
    ['child', 1],
    ['grandchild', 2],
    ['older-child', 1],
    ['lone', 0],
  ]);
});

it('leads with a pinned family whatever its members changed', () => {
  const sessions = [session('recent', '2026-11-09'), session('pinned', '2026-11-01', null, true)];
  expect(familyOrder(sessions).map(({ session }) => session.sessionId)).toEqual([
    'pinned',
    'recent',
  ]);
});

it('puts a family in the most urgent group of its members and says what differs', () => {
  const sessions = [session('parent', '2026-11-01'), session('child', '2026-11-02', 'parent')];
  const runs = [run('parent', 'cancelled'), run('child', 'awaiting_user')];
  const groups = sessionGroups(sessions, runs, []);
  expect(groups.map((group) => group.id)).toEqual(['attention']);
  const [parent] = groups[0]?.rows ?? [];
  expect(parent).toMatchObject({
    session: { sessionId: 'parent' },
    attention: [],
    state: 'cancelled',
  });
  expect(parent?.children).toHaveLength(1);
  expect(parent?.children[0]).toMatchObject({
    session: { sessionId: 'child' },
    attention: ['awaiting_user'],
    state: null,
    children: [],
  });
  expect(groups[0]?.count).toBe(2);
});

it('writes no state on a member whose own group is the family group', () => {
  const sessions = [session('parent', '2026-11-01'), session('child', '2026-11-02', 'parent')];
  const runs = [run('parent', 'succeeded'), run('child', 'succeeded')];
  const [group] = sessionGroups(sessions, runs, []);
  expect(group?.id).toBe('completed');
  expect(group?.rows[0]).toMatchObject({ state: null });
  expect(group?.rows[0]?.children[0]).toMatchObject({ state: null });
});

it('marks a row empty by its own session, whatever group the family sits in', async () => {
  const sessions = [
    session('parent', '2026-11-01'),
    { ...session('child', '2026-11-02', 'parent'), entries: [] } as WorkSession,
  ];
  const [group] = sessionGroups(sessions, [run('parent', 'running')], []);
  expect(group?.id).toBe('running');
  expect(group?.rows[0]).toMatchObject({ empty: false });
  expect(group?.rows[0]?.children[0]).toMatchObject({ empty: true, state: 'empty' });
});
