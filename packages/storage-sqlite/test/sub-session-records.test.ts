import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, SqliteCorralRepository } from '../src/index.ts';
import { deleteSessionRecords } from '../src/session-deletion.ts';

// docs/specs/features/sub-sessions.md: the parent link is read back, and deleting a session
// leaves its sub-sessions with no parent.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function family() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-sub-session-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'corral.db'));
  const repository = new SqliteCorralRepository(db, {
    clock: new FakeClock(),
    newCorralId: () => 'corral_new',
  });
  const make = async (title: string) => {
    const created = await repository.createSession({ projectId: 'default', title });
    if (!created.ok) throw new Error(created.message);
    return created.session.sessionId;
  };
  const a = await make('A');
  const b = await make('B');
  const c = await make('C');
  const link = db.prepare('UPDATE work_sessions SET parent_session_id=? WHERE id=?');
  link.run(a, b);
  link.run(b, c);
  return { dir, db, repository, a, b, c };
}

it('reads each session parent back, null for a main session', async () => {
  const f = await family();
  try {
    const parents = Object.fromEntries(
      (await f.repository.listSessions('default')).map((s) => [s.sessionId, s.parentSessionId]),
    );
    expect(parents).toEqual({ [f.a]: null, [f.b]: f.a, [f.c]: f.b });
    expect((await f.repository.getSession(f.c))?.parentSessionId).toBe(f.b);
  } finally {
    f.db.close();
  }
});

it('deleting the middle session leaves its sub-session at the top and drops its command', async () => {
  const f = await family();
  try {
    f.db
      .prepare(
        'INSERT INTO sub_session_commands (command_id, request_hash, parent_session_id, session_id, created_at) VALUES (?,?,?,?,?)',
      )
      .run('open_b', 'h', f.a, f.b, 'x');
    expect(deleteSessionRecords(f.db, f.b, 1, f.dir)).toMatchObject({ ok: true });
    expect((await f.repository.getSession(f.c))?.parentSessionId).toBeNull();
    expect((await f.repository.getSession(f.a))?.parentSessionId).toBeNull();
    expect(f.db.prepare('SELECT count(*) AS n FROM sub_session_commands').get()).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});
