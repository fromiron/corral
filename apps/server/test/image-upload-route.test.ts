import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository } from '@corral/client';
import { openDatabase } from '@corral/storage-sqlite';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { startCorralServer } from '../src/index.ts';

// POST /sessions/:id/images answers its failures with the error table's codes (api-contract.md,
// 명령과 조회): the input's refusals 400 SCHEMA_INVALID, a missing session 404 TARGET_NOT_FOUND,
// the session's 64 MiB of input images 409 LIMIT_REACHED, a store error 503 STORAGE_UNAVAILABLE.
// An archived session still takes images, as its entries do.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const TOKEN = 'test-image-upload-route-0123456789ab';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==',
  'base64',
);

async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'corral-image-route-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const server = await startCorralServer({
    workspace,
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: TOKEN,
    agents: new ScriptedAgentAdapter({ turns: 1, reply: () => 'Done.' }),
  });
  cleanup.push(() => server.close());
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token: TOKEN }),
  });
  const headers = {
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    origin: server.url,
  };
  const call: typeof fetch = (input, init = {}) => {
    const merged = new Headers(init.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
    return fetch(input, { ...init, headers: merged });
  };
  const upload = async (sessionId: string, body: Buffer | string = PNG, name = 'pixel.png') => {
    const response = await call(`${server.url}/api/v1/sessions/${sessionId}/images?name=${name}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: typeof body === 'string' ? body : new Uint8Array(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
  const created = await repository.createSession({ projectId: 'default', title: 'Images' });
  if (!created.ok) throw new Error(created.message);
  /** The server's own store, opened beside it, to set up what a route cannot. */
  const store = () => {
    const db = openDatabase(join(workspace, '.corral', 'corral.db'));
    cleanup.push(() => void db.close());
    return db;
  };
  return { upload, repository, store, session: created.session };
}

it('an image goes into its session and answers 201', async () => {
  const s = await boot();
  const sent = await s.upload(s.session.sessionId);
  expect(sent.status).toBe(201);
  expect(sent.body).toMatchObject({ kind: 'image_attachment', width: 1, height: 1 });
});

it('a body that is not a PNG, or a bad name, stays 400 SCHEMA_INVALID (반례)', async () => {
  const s = await boot();
  for (const sent of [
    await s.upload(s.session.sessionId, 'not a png'),
    await s.upload(s.session.sessionId, PNG, '..%2Fpixel.png'),
  ]) {
    expect(sent.status).toBe(400);
    expect(sent.body.error.code).toBe('SCHEMA_INVALID');
  }
});

it('a session that does not exist answers 404 TARGET_NOT_FOUND (반례)', async () => {
  const s = await boot();
  const sent = await s.upload('session_missing');
  expect(sent.status).toBe(404);
  expect(sent.body.error.code).toBe('TARGET_NOT_FOUND');
});

it('an archived session still takes an image', async () => {
  const s = await boot();
  const archived = await s.repository.updateSession(s.session.sessionId, {
    archived: true,
    expectedRevision: s.session.revision,
  });
  if (!archived.ok) throw new Error(archived.message);
  const sent = await s.upload(s.session.sessionId);
  expect(sent.status).toBe(201);
});

it('a session whose input images are at 64 MiB answers 409 LIMIT_REACHED, and stores nothing (반례)', async () => {
  const s = await boot();
  const db = s.store();
  // The session's images already fill its 64 MiB, less than the next image needs.
  db.prepare(
    'INSERT INTO input_images (session_id,id,metadata_json,body,created_at) VALUES (?,?,?,?,?)',
  ).run(
    s.session.sessionId,
    'image_filler',
    '{}',
    Buffer.alloc(64 * 1024 * 1024 - 10),
    '2026-11-18T00:00:00.000Z',
  );
  const sent = await s.upload(s.session.sessionId);
  expect(sent.status).toBe(409);
  expect(sent.body.error.code).toBe('LIMIT_REACHED');
  const count = db
    .prepare('SELECT count(*) AS n FROM input_images WHERE session_id=?')
    .get(s.session.sessionId) as { n: number };
  expect(count.n).toBe(1);
});

it('a store that cannot record answers 503 STORAGE_UNAVAILABLE (반례)', async () => {
  const s = await boot();
  // The image table is gone: the store fails under a valid request.
  s.store().exec('DROP TABLE input_images');
  const sent = await s.upload(s.session.sessionId);
  expect(sent.status).toBe(503);
  expect(sent.body.error.code).toBe('STORAGE_UNAVAILABLE');
});
