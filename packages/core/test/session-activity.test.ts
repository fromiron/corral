import { expect, it } from 'vitest';
import { planSessionUpdate, type WorkSession } from '../src/repository/index.ts';

const current = {
  sessionId: 'session',
  title: 'Review',
  objective: '',
  corralId: null,
  auto: null,
  projectId: 'default',
  autoTitle: false,
  pinned: false,
  revision: 3,
  createdAt: '2026-10-28T00:00:00Z',
  updatedAt: '2026-10-28T01:00:00Z',
  archivedAt: null,
  entries: [],
} satisfies WorkSession;

it('pin and unpin retain activity time while keeping revision conflict checks', () => {
  const pinned = planSessionUpdate(
    current,
    current.sessionId,
    { pinned: true, expectedRevision: 3 },
    '2026-10-29T00:00:00Z',
  );
  expect(pinned).toMatchObject({
    ok: true,
    session: { pinned: true, revision: 4, updatedAt: current.updatedAt },
  });
  if (!pinned.ok) throw new Error(pinned.message);
  const unpinned = planSessionUpdate(
    pinned.session,
    current.sessionId,
    { pinned: false, expectedRevision: 4 },
    '2026-10-30T00:00:00Z',
  );
  expect(unpinned).toMatchObject({
    ok: true,
    session: { pinned: false, revision: 5, updatedAt: current.updatedAt },
  });
  expect(
    planSessionUpdate(
      pinned.session,
      current.sessionId,
      { pinned: false, expectedRevision: 3 },
      '2026-10-30T00:00:00Z',
    ),
  ).toMatchObject({ ok: false, error: 'revision_conflict' });
});

it('a rename saved with a pin still records real activity', () => {
  expect(
    planSessionUpdate(
      current,
      current.sessionId,
      { title: 'New name', pinned: true, expectedRevision: 3 },
      '2026-10-29T00:00:00Z',
    ),
  ).toMatchObject({ ok: true, session: { updatedAt: '2026-10-29T00:00:00Z' } });
});
