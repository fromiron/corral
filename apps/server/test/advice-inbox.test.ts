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

// Opening is recorded with its time; advice left at that row after it is an item again, and
// opening again writes the time anew (features/inbox.md; api-contract.md). When an advice was left
// is read from its `advice.admitted` event in the run's record, in the server's clock.

type Unread = {
  adviceId: string;
  targetExecutionId: string;
  severity: 'concern' | 'blocker';
  text: string;
};

function recorded() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const clock = new FakeClock();
  const review = new ReviewService({
    db,
    clock,
    files: { copyOf: () => null } as unknown as WorkspaceService,
  });
  db.prepare(
    `INSERT INTO runs (id, corral_id, definition_hash, snapshot_json, status, last_seq,
       projection_json, started_at)
     VALUES ('run_1', 'c', 'h', '{}', 'running', 0, '{}', 'x')`,
  ).run();
  const unread: Unread[] = [];
  let seq = 0;
  /** An advisor leaves an advice now: its admitted event, and the unread item it becomes. */
  const leave = (adviceId: string, targetExecutionId: string, text: string) => {
    seq += 1;
    db.prepare(
      'INSERT INTO run_events (run_id, seq, event_id, type, event_json) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'run_1',
      seq,
      `event_${seq}`,
      'advice.admitted',
      JSON.stringify({
        type: 'advice.admitted',
        runId: 'run_1',
        runSeq: seq,
        recordedAt: clock.nowIso(),
        payload: { adviceId, targetExecutionId },
      }),
    );
    unread.push({ adviceId, targetExecutionId, severity: 'concern', text });
  };
  const sessions = [{ sessionId: 'session', title: 'Parser fix', entries: [] }];
  const runs = [{ runId: 'run_1', status: 'running', sessionId: 'session' }];
  const inbox = () =>
    review
      .inbox(sessions, runs, () => unread)
      .flatMap((item) => (item.kind === 'advice' ? [item.detail] : []));
  return { review, clock, leave, inbox };
}

it('lists again an advice left at a row after it was opened', () => {
  const { review, clock, leave, inbox } = recorded();
  leave('a_first', 'exec_writer', 'First concern.');
  expect(inbox()).toEqual(['First concern.']);
  clock.advance(1000);
  // The person reads it in full: it leaves.
  review.markExecutionOpened('run_1', 'exec_writer');
  expect(inbox()).toEqual([]);
  // The last review's blocker reaches the same row after its target ended.
  clock.advance(1000);
  leave('a_last', 'exec_writer', 'Stop.');
  expect(inbox()).toEqual(['Stop.']);
});

it('keeps an opened row out while nothing was left at it after', () => {
  const { review, clock, leave, inbox } = recorded();
  leave('a_first', 'exec_writer', 'First concern.');
  clock.advance(1000);
  review.markExecutionOpened('run_1', 'exec_writer');
  clock.advance(60_000);
  expect(inbox()).toEqual([]);
});

it('takes an advice left at the very time the row was opened as seen with it', () => {
  const { review, leave, inbox } = recorded();
  leave('a_first', 'exec_writer', 'First concern.');
  review.markExecutionOpened('run_1', 'exec_writer');
  expect(inbox()).toEqual([]);
});

it('writes the time anew when the row is opened again, and the later advice leaves too', () => {
  const { review, clock, leave, inbox } = recorded();
  leave('a_first', 'exec_writer', 'First concern.');
  clock.advance(1000);
  review.markExecutionOpened('run_1', 'exec_writer');
  clock.advance(1000);
  leave('a_last', 'exec_writer', 'Stop.');
  expect(inbox()).toEqual(['Stop.']);
  clock.advance(1000);
  review.markExecutionOpened('run_1', 'exec_writer');
  expect(inbox()).toEqual([]);
});

it('keeps each row’s opening its own', () => {
  const { review, clock, leave, inbox } = recorded();
  leave('a_writer', 'exec_writer', 'Writer concern.');
  leave('a_editor', 'exec_editor', 'Editor concern.');
  clock.advance(1000);
  review.markExecutionOpened('run_1', 'exec_writer');
  clock.advance(1000);
  leave('a_editor_2', 'exec_editor', 'Editor again.');
  // The writer's row was opened; the editor's never was: both of its advice stay.
  expect(inbox()).toEqual(['Editor concern.', 'Editor again.']);
  leave('a_writer_2', 'exec_writer', 'Writer again.');
  expect(inbox()).toEqual(['Editor concern.', 'Editor again.', 'Writer again.']);
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
