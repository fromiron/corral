import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { ReviewService } from '../src/files/review.ts';
import type { WorkspaceService } from '../src/files/service.ts';

// The inbox's `advice` items (features/inbox.md): advice an ended target never read, until the
// person opens that execution row.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(texts?: readonly string[]) {
  const db = openDatabase(':memory:');
  databases.push(db);
  const review = new ReviewService({
    db,
    clock: new FakeClock(),
    files: { copyOf: () => null } as unknown as WorkspaceService,
  });
  const sessions = [{ sessionId: 'session', title: 'Parser fix', entries: [] }];
  const runs = [
    { runId: 'run_1', status: 'succeeded', sessionId: 'session' },
    { runId: 'run_other', status: 'succeeded', sessionId: 'elsewhere' },
  ];
  const unread = (runId: string) =>
    texts && runId === 'run_1'
      ? texts.map((text, at) => ({
          targetExecutionId: `exec_${at}`,
          severity: 'nit' as const,
          text,
        }))
      : !texts && (runId === 'run_1' || runId === 'run_other')
        ? [
            {
              targetExecutionId: 'exec_writer',
              severity: 'concern' as const,
              text: 'The tokenizer drops the last token.\nSee the loop bound.',
            },
            { targetExecutionId: 'exec_editor', severity: 'blocker' as const, text: 'Stop.' },
          ]
        : [];
  return { review, inbox: () => review.inbox(sessions, runs, unread) };
}

it('lists each unread advice with its severity, first line and execution row', () => {
  const { inbox } = fixture();
  expect(inbox().filter((item) => item.kind === 'advice')).toEqual([
    {
      kind: 'advice',
      sessionId: 'session',
      sessionTitle: 'Parser fix',
      runId: 'run_1',
      executionId: 'exec_writer',
      severity: 'concern',
      detail: 'The tokenizer drops the last token.',
    },
    {
      kind: 'advice',
      sessionId: 'session',
      sessionTitle: 'Parser fix',
      runId: 'run_1',
      executionId: 'exec_editor',
      severity: 'blocker',
      detail: 'Stop.',
    },
  ]);
});

it('an item leaves once its execution row was opened, and opening again changes nothing', () => {
  const { review, inbox } = fixture();
  review.markExecutionOpened('run_1', 'exec_writer');
  review.markExecutionOpened('run_1', 'exec_writer');
  expect(inbox().flatMap((item) => (item.kind === 'advice' ? [item.executionId] : []))).toEqual([
    'exec_editor',
  ]);
  // Opening the same execution id in another run does not clear this one.
  review.markExecutionOpened('run_other', 'exec_editor');
  expect(inbox().filter((item) => item.kind === 'advice')).toHaveLength(1);
});

// Known gap, left to the server (reported from A8b): opening is recorded per execution row, so an
// advice that reaches that row after it was opened never enters Needs you. `it.fails` keeps it
// visible without stopping the suite; once the server records opening per advice it starts to
// pass, and `.fails` must go.
it.fails('an advice that reaches a row after it was opened is still listed', () => {
  const db = openDatabase(':memory:');
  databases.push(db);
  const review = new ReviewService({
    db,
    clock: new FakeClock(),
    files: { copyOf: () => null } as unknown as WorkspaceService,
  });
  const sessions = [{ sessionId: 'session', title: 'Parser fix', entries: [] }];
  const runs = [{ runId: 'run_1', status: 'running', sessionId: 'session' }];
  const unread: { targetExecutionId: string; severity: 'concern' | 'blocker'; text: string }[] = [
    { targetExecutionId: 'exec_writer', severity: 'concern', text: 'First concern.' },
  ];
  const inbox = () =>
    review
      .inbox(sessions, runs, () => unread)
      .flatMap((item) => (item.kind === 'advice' ? [item.detail] : []));
  expect(inbox()).toEqual(['First concern.']);
  // The person reads it in full: it leaves.
  review.markExecutionOpened('run_1', 'exec_writer');
  expect(inbox()).toEqual([]);
  // A later review's blocker reaches the same row after its target ended.
  unread.push({ targetExecutionId: 'exec_writer', severity: 'blocker', text: 'Stop.' });
  expect(inbox()).toEqual(['Stop.']);
});

it('names an advice by its first line that has text, trimmed and at most 120 characters', () => {
  const long = `${'word '.repeat(40)}end`;
  const { inbox } = fixture([
    '\n  \n   The bound is off by one.  \nSee the loop.',
    `\r\n${long}`,
    ' \n\t\n',
  ]);
  expect(inbox().flatMap((item) => (item.kind === 'advice' ? [item.detail] : []))).toEqual([
    'The bound is off by one.',
    long.slice(0, 120),
    null,
  ]);
});
