import type { InboxItemView } from '@corral/client';
import { expect, it, vi } from 'vitest';
import { inboxNotificationTargets, notificationDestination } from './notifications.ts';

const decision: InboxItemView = {
  kind: 'decision',
  sessionId: 'session_a',
  runId: 'run_a',
  sessionTitle: 'Private title',
  detail: 'Private body',
};
const session: { sessionId: string; projectId: string; archivedAt: string | null } = {
  sessionId: 'session_a',
  projectId: 'project_a',
  archivedAt: null,
};

it('inbox targets exclude private text and detect equal-count replacements without duplicates', () => {
  const first = inboxNotificationTargets([decision, decision]);
  expect(first).toEqual([{ kind: 'decision', sessionId: 'session_a', runId: 'run_a' }]);
  expect(inboxNotificationTargets([decision], first)).toEqual([]);
  expect(inboxNotificationTargets([{ ...decision, runId: 'run_b' }], first)).toEqual([
    { kind: 'decision', sessionId: 'session_a', runId: 'run_b' },
  ]);
});

it('a live notification opens its exact run or review, never the latest run', async () => {
  const source = { getSession: vi.fn(async () => session), inbox: vi.fn(async () => [decision]) };
  expect(await notificationDestination(decision, source)).toBe(
    '/sessions/session_a?panel=run&view=run&run=run_a',
  );
  const review = { ...decision, kind: 'check_failed' as const, runId: null };
  source.inbox.mockResolvedValue([review]);
  expect(await notificationDestination(review, source)).toBe('/sessions/session_a/review');
});

it('deleted, archived, resolved or mismatched notification targets cannot navigate', async () => {
  const source = {
    getSession: vi.fn(async (): Promise<typeof session | null> => session),
    inbox: vi.fn(async (): Promise<InboxItemView[]> => [decision]),
  };
  expect(await notificationDestination({ ...decision, runId: 'run_other' }, source)).toBeNull();
  source.inbox.mockResolvedValue([]);
  expect(await notificationDestination(decision, source)).toBeNull();
  source.getSession.mockResolvedValue(null);
  expect(await notificationDestination(decision, source)).toBeNull();
  source.getSession.mockResolvedValue({ ...session, archivedAt: 'now' });
  expect(await notificationDestination(decision, source)).toBeNull();
});

it('opens only the exact still-uncertain terminal and keeps two terminal identities separate', async () => {
  const terminal = {
    ...decision,
    kind: 'uncertain_terminal' as const,
    runId: null,
    terminalId: 'terminal_a',
  };
  const source = { getSession: vi.fn(async () => session), inbox: vi.fn(async () => [terminal]) };
  expect(inboxNotificationTargets([terminal, { ...terminal, terminalId: 'terminal_b' }])).toEqual([
    { kind: 'uncertain_terminal', sessionId: 'session_a', runId: null, terminalId: 'terminal_a' },
    { kind: 'uncertain_terminal', sessionId: 'session_a', runId: null, terminalId: 'terminal_b' },
  ]);
  expect(await notificationDestination(terminal, source)).toBe(
    '/sessions/session_a?panel=terminal&terminal=terminal_a',
  );
  expect(
    await notificationDestination({ ...terminal, terminalId: 'terminal_other' }, source),
  ).toBeNull();
  expect(await notificationDestination({ ...terminal, terminalId: undefined }, source)).toBeNull();
  source.inbox.mockResolvedValue([]);
  expect(await notificationDestination(terminal, source)).toBeNull();
});
