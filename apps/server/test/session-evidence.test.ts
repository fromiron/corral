import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspacesApi } from '@corral/client';
import { VerificationReport } from '@corral/contracts';
import { type Db, openDatabase } from '@corral/storage-sqlite';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';

// GET /projects/:projectId/session-evidence against the real server and its SQLite file. Rows are
// seeded through a second connection after start, so start-up recovery cannot rewrite them.

const TOKEN = 'test-bootstrap-token-0123456789abcdef';
const MARKER = 'PRIVATE-MARKER-7f3a';
const TREE = 'a'.repeat(40);
const servers: CorralServer[] = [];
const databases: Db[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-session-evidence-'));
  dirs.push(dir);
  return dir;
}

/** Minutes after a fixed origin, so "later" is explicit in every case. */
const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 0, minute)).toISOString();

type ReportState = VerificationReport['state'];
type Verdict = VerificationReport['verdict'];

function seeder(db: Db) {
  let n = 0;
  const next = (prefix: string) => `${prefix}_${++n}`;
  return {
    project(id: string) {
      db.prepare(
        `INSERT INTO projects (id,name,description,revision,created_at,updated_at,archived_at)
         VALUES (?,?,'',1,?,?,NULL)`,
      ).run(id, id, at(0), at(0));
    },
    session(id: string, projectId: string, options: { archived?: boolean; text?: string } = {}) {
      const entry = {
        entryId: next('entry'),
        intent: 'next',
        text: options.text ?? 'make the change',
        createdAt: at(0),
        state: 'sent',
        runId: null,
        executionId: null,
        detail: null,
      };
      db.prepare(
        `INSERT INTO work_sessions
           (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json)
         VALUES (?,?,NULL,?,?,0,1,?,?,?,?)`,
      ).run(
        id,
        projectId,
        `Session ${id}`,
        options.text ?? '',
        at(0),
        at(0),
        options.archived ? at(1) : null,
        JSON.stringify([entry]),
      );
    },
    /** A check row as the workspace service records it: report JSON plus the derived column. */
    check(
      sessionId: string,
      minute: number,
      state: ReportState,
      verdict: Verdict,
      options: { name?: string; output?: string } = {},
    ) {
      const id = next('verification');
      const command = { id: 'unit', name: options.name ?? 'Unit tests', argv: ['pnpm', 'test'] };
      const output = options.output ?? 'ok';
      const report = VerificationReport.parse({
        verificationId: id,
        owner: { kind: 'manual', sessionId },
        sessionId,
        commandId: command.id,
        configRevision: 1,
        fingerprint: 'f'.repeat(64),
        tree: TREE,
        state,
        verdict,
        exitCode: state === 'completed' ? (verdict === 'fail' ? 1 : 0) : null,
        signal: null,
        timedOut: false,
        cleanupConfirmed: true,
        targetUnchanged: null,
        durationMs: 10,
        startedAt: at(minute),
        endedAt: ['queued', 'running'].includes(state) ? null : at(minute),
        retainUntil: at(minute + 7 * 24 * 60),
        output: { text: output, bytes: output.length, hash: '0'.repeat(64), truncated: false },
      });
      const column = ['queued', 'running'].includes(state)
        ? 'running'
        : verdict === 'pass'
          ? 'passed'
          : verdict === 'fail'
            ? 'failed'
            : 'error';
      db.prepare(
        `INSERT INTO verifications (id,session_id,command_id,command_json,tree,exit_code,signal,
           timed_out,duration_ms,output_tail,state,started_at,ended_at,report_json)
         VALUES (?,?,?,?,?,?,NULL,0,10,?,?,?,?,?)`,
      ).run(
        id,
        sessionId,
        command.id,
        JSON.stringify(command),
        TREE,
        report.exitCode,
        output,
        column,
        report.startedAt,
        report.endedAt,
        JSON.stringify(report),
      );
      return id;
    },
    decision(
      sessionId: string,
      minute: number,
      decision: 'approved' | 'changes_requested',
      note = 'looks fine',
    ) {
      const id = next('decision');
      db.prepare(
        `INSERT INTO review_decisions (id,session_id,from_tree,to_tree,decision,note,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(id, sessionId, TREE, TREE, decision, note, at(minute));
      return id;
    },
    integration(
      sessionId: string,
      minute: number,
      state: 'applying' | 'applied' | 'partial' | 'conflict' | 'reverted' | 'failed',
      decisionId: string,
      path = 'src/app.ts',
    ) {
      const id = next('integration');
      db.prepare(
        `INSERT INTO integrations (id,session_id,decision_id,from_tree,to_tree,state,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, sessionId, decisionId, TREE, TREE, state, at(minute), at(minute));
      db.prepare(
        `INSERT INTO integration_files (integration_id,path,action,expected_hash,after_hash,outcome,detail)
         VALUES (?,?,'write',NULL,NULL,'applied',NULL)`,
      ).run(id, path);
      return id;
    },
    write(
      sessionId: string,
      minute: number,
      options: { state?: 'planned' | 'applied' | 'failed' | 'uncertain'; path?: string } = {},
    ) {
      db.prepare(
        `INSERT INTO file_operations (id,session_id,run_id,execution_id,tool_call_id,kind,path,to_path,
           before_hash,after_hash,state,detail,created_at,updated_at)
         VALUES (?,?,'run_1','exec_1','call_1','write',?,NULL,NULL,NULL,?,NULL,?,?)`,
      ).run(
        next('op'),
        sessionId,
        options.path ?? 'src/app.ts',
        options.state ?? 'applied',
        at(minute),
        at(minute),
      );
    },
  };
}

async function signedIn(server: CorralServer) {
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token: TOKEN }),
  });
  expect(login.status).toBe(204);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call: typeof fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    headers.set('origin', server.url);
    return fetch(input, { ...init, headers });
  };
  return call;
}

async function start() {
  const workspace = tempDir();
  const server = await startCorralServer({
    workspace,
    port: 0,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    bootstrapToken: TOKEN,
    worktreeRoot: join(tempDir(), 'worktrees'),
  });
  servers.push(server);
  const db = openDatabase(join(workspace, '.corral', 'corral.db'));
  databases.push(db);
  const call = await signedIn(server);
  const read = async (projectId: string) => {
    const response = await call(
      `${server.url}/api/v1/projects/${encodeURIComponent(projectId)}/session-evidence`,
    );
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as unknown };
  };
  const seed = seeder(db);
  seed.project('proj');
  return { server, db, call, read, seed };
}

type Evidence = {
  sessionId: string;
  check: { name: string; verdict: string; writesSince: boolean } | null;
  decision: { decision: string; writesSince: boolean } | null;
  integration: string | null;
};

async function evidenceOf(read: (projectId: string) => Promise<{ body: unknown }>) {
  const { body } = await read('proj');
  return new Map((body as Evidence[]).map((item) => [item.sessionId, item]));
}

const TABLES = [
  'projects',
  'work_sessions',
  'verifications',
  'review_decisions',
  'integrations',
  'integration_files',
  'file_operations',
];
const snapshot = (db: Db) =>
  Object.fromEntries(
    TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );

describe('session evidence', () => {
  it('reports the latest completed check and whether a write was recorded after it', async () => {
    const { read, seed } = await start();
    seed.session('passed', 'proj');
    seed.check('passed', 10, 'completed', 'pass');
    seed.write('passed', 5);
    seed.session('changed', 'proj');
    seed.check('changed', 10, 'completed', 'pass');
    seed.write('changed', 11);
    seed.session('not_applied', 'proj');
    seed.check('not_applied', 10, 'completed', 'pass');
    seed.write('not_applied', 11, { state: 'failed' });
    seed.write('not_applied', 12, { state: 'uncertain' });
    seed.write('not_applied', 13, { state: 'planned' });
    seed.session('failed', 'proj');
    seed.check('failed', 10, 'completed', 'fail');
    seed.session('inconclusive', 'proj');
    seed.check('inconclusive', 10, 'completed', 'inconclusive');
    seed.session('not_evaluated', 'proj');
    seed.check('not_evaluated', 10, 'completed', 'not_evaluated', { name: 'Lint' });

    const evidence = await evidenceOf(read);
    expect(evidence.get('passed')?.check).toEqual({
      name: 'Unit tests',
      verdict: 'pass',
      writesSince: false,
    });
    expect(evidence.get('changed')?.check).toEqual({
      name: 'Unit tests',
      verdict: 'pass',
      writesSince: true,
    });
    // Only applied writes count; planned, failed and uncertain ones are not recorded writes.
    expect(evidence.get('not_applied')?.check?.writesSince).toBe(false);
    expect(evidence.get('failed')?.check).toEqual({
      name: 'Unit tests',
      verdict: 'fail',
      writesSince: false,
    });
    expect(evidence.get('inconclusive')?.check?.verdict).toBe('inconclusive');
    expect(evidence.get('not_evaluated')?.check).toEqual({
      name: 'Lint',
      verdict: 'not_evaluated',
      writesSince: false,
    });
  });

  it.each([
    ['cancelled', 'not_evaluated'],
    ['error', 'inconclusive'],
    ['queued', 'not_evaluated'],
    ['running', 'not_evaluated'],
  ] as const)('has no check when the latest one is %s', async (state, verdict) => {
    const { read, seed } = await start();
    seed.session('only', 'proj');
    seed.check('only', 10, state, verdict);
    seed.session('after_pass', 'proj');
    seed.check('after_pass', 5, 'completed', 'pass');
    seed.check('after_pass', 10, state, verdict);
    const evidence = await evidenceOf(read);
    expect(evidence.get('only')?.check).toBeNull();
    // The latest check wins: an older pass does not show through a newer unfinished one.
    expect(evidence.get('after_pass')?.check).toBeNull();
  });

  it('takes the latest check even when an older one passed and a newer one completed', async () => {
    const { read, seed } = await start();
    seed.session('s', 'proj');
    seed.check('s', 5, 'completed', 'pass');
    seed.check('s', 10, 'completed', 'fail', { name: 'Integration' });
    seed.check('s', 1, 'cancelled', 'not_evaluated');
    expect((await evidenceOf(read)).get('s')?.check).toEqual({
      name: 'Integration',
      verdict: 'fail',
      writesSince: false,
    });
  });

  it('reports the latest decision and whether a write was recorded after it', async () => {
    const { read, seed } = await start();
    seed.session('approved', 'proj');
    seed.decision('approved', 10, 'approved');
    seed.write('approved', 9);
    seed.session('approved_then_written', 'proj');
    seed.decision('approved_then_written', 10, 'approved');
    seed.write('approved_then_written', 11);
    seed.session('requested', 'proj');
    seed.decision('requested', 5, 'approved');
    seed.decision('requested', 10, 'changes_requested');
    seed.session('none', 'proj');

    const evidence = await evidenceOf(read);
    expect(evidence.get('approved')?.decision).toEqual({
      decision: 'approved',
      writesSince: false,
    });
    expect(evidence.get('approved_then_written')?.decision).toEqual({
      decision: 'approved',
      writesSince: true,
    });
    expect(evidence.get('requested')?.decision).toEqual({
      decision: 'changes_requested',
      writesSince: false,
    });
    expect(evidence.get('none')).toEqual({
      sessionId: 'none',
      check: null,
      decision: null,
      integration: null,
    });
  });

  it.each(['applying', 'applied', 'partial', 'conflict', 'reverted', 'failed'] as const)(
    'passes the latest integration state through: %s',
    async (state) => {
      const { read, seed } = await start();
      seed.session('s', 'proj');
      const decision = seed.decision('s', 1, 'approved');
      seed.integration('s', 2, state === 'applied' ? 'failed' : 'applied', decision);
      seed.integration('s', 3, state, decision);
      expect((await evidenceOf(read)).get('s')?.integration).toBe(state);
    },
  );

  it('lists only the unarchived sessions of the project and 404s for an unknown one', async () => {
    const { read, seed } = await start();
    seed.project('other');
    seed.session('kept', 'proj');
    seed.session('archived', 'proj', { archived: true });
    seed.check('archived', 1, 'completed', 'pass');
    seed.session('elsewhere', 'other');
    seed.check('elsewhere', 1, 'completed', 'pass');

    const { status, body } = await read('proj');
    expect(status).toBe(200);
    expect(body).toEqual([{ sessionId: 'kept', check: null, decision: null, integration: null }]);
    expect((await read('other')).body).toEqual([
      {
        sessionId: 'elsewhere',
        check: { name: 'Unit tests', verdict: 'pass', writesSince: false },
        decision: null,
        integration: null,
      },
    ]);
    const missing = await read('missing_project');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: { code: 'TARGET_NOT_FOUND', message: 'no such project' },
    });
  });

  it('refuses a caller without a session', async () => {
    const { server } = await start();
    expect((await fetch(`${server.url}/api/v1/projects/proj/session-evidence`)).status).toBe(401);
  });

  it('never carries request text, file paths, check output or decision notes', async () => {
    const { read, seed } = await start();
    seed.session('s', 'proj', { text: `please ${MARKER} now` });
    seed.write('s', 1, { path: `src/${MARKER}.ts` });
    seed.check('s', 2, 'completed', 'pass', { output: `stdout ${MARKER}` });
    const decision = seed.decision('s', 3, 'approved', `note ${MARKER}`);
    seed.integration('s', 4, 'applied', decision, `lib/${MARKER}.ts`);
    seed.write('s', 5, { path: `docs/${MARKER}.md` });

    const { text, body } = await read('proj');
    expect(body).toEqual([
      {
        sessionId: 's',
        check: { name: 'Unit tests', verdict: 'pass', writesSince: true },
        decision: { decision: 'approved', writesSince: true },
        integration: 'applied',
      },
    ]);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('src/');
  });

  it('changes nothing it reads', async () => {
    const { db, read, seed } = await start();
    seed.session('s', 'proj');
    seed.check('s', 1, 'completed', 'pass');
    seed.check('s', 2, 'running', 'not_evaluated');
    seed.write('s', 3);
    const decision = seed.decision('s', 4, 'approved');
    seed.integration('s', 5, 'applying', decision);
    // Retention would blank an expired output when the session's check list is read.
    db.prepare(
      `UPDATE verifications SET report_json = json_set(report_json, '$.retainUntil', ?)`,
    ).run(at(0));

    const before = snapshot(db);
    const version = db.pragma('data_version', { simple: true });
    expect((await read('proj')).status).toBe(200);
    expect((await read('proj')).status).toBe(200);
    expect(snapshot(db)).toEqual(before);
    // data_version moves when any other connection commits, so the server wrote nothing.
    expect(db.pragma('data_version', { simple: true })).toBe(version);
  });

  it('reads with the same number of statements for one session and for fifty', async () => {
    const { db, read, seed } = await start();
    const fill = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        const id = `s${i}`;
        seed.session(id, 'proj');
        seed.check(id, 1, 'completed', 'pass');
        seed.write(id, 2);
        const decision = seed.decision(id, 3, 'approved');
        seed.integration(id, 4, 'applied', decision);
      }
    };
    // better-sqlite3 compiles a statement in Database#prepare and runs it with Statement#all,
    // #get, #run or #iterate; both prototypes are shared with the server's own connection.
    const statementPrototype = Object.getPrototypeOf(db.prepare('SELECT 1')) as Record<
      'all' | 'get' | 'run' | 'iterate',
      (...args: unknown[]) => unknown
    >;
    const counted = async () => {
      const spies = [
        vi.spyOn(Object.getPrototypeOf(db) as { prepare: Db['prepare'] }, 'prepare'),
        ...(['all', 'get', 'run', 'iterate'] as const).map((method) =>
          vi.spyOn(statementPrototype, method),
        ),
      ];
      const { body } = await read('proj');
      const calls = spies.map((spy) => spy.mock.calls.length);
      for (const spy of spies) spy.mockRestore();
      return { sessions: (body as unknown[]).length, prepared: calls[0], executed: calls.slice(1) };
    };
    fill(0, 1);
    const one = await counted();
    fill(1, 50);
    const fifty = await counted();
    expect(one.sessions).toBe(1);
    expect(fifty.sessions).toBe(50);
    expect(fifty.prepared).toBe(one.prepared);
    expect(fifty.executed).toEqual(one.executed);
    // The spies see the server's connection (the project lookup and the evidence statement today).
    expect(one.prepared).toBeGreaterThan(0);
    expect(one.prepared).toBeLessThanOrEqual(4);
  });

  it('is what the client method returns', async () => {
    const { server, call, seed } = await start();
    seed.session('s', 'proj');
    seed.check('s', 1, 'completed', 'pass');
    const api = new WorkspacesApi({ baseUrl: server.url, fetch: call });
    expect(await api.sessionEvidence('proj')).toEqual([
      {
        sessionId: 's',
        check: { name: 'Unit tests', verdict: 'pass', writesSince: false },
        decision: null,
        integration: null,
      },
    ]);
    await expect(api.sessionEvidence('missing_project')).rejects.toMatchObject({
      status: 404,
      code: 'TARGET_NOT_FOUND',
    });
  });
});
