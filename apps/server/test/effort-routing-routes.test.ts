import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffortRoutingSettings } from '@corral/contracts';
import { type D1Child, D1Engine, type D1Manifest, LINUX_X64_CPU } from '@corral/local-intelligence';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { decisionApiConsent } from '../src/decision-apis.ts';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import { fakeOpenAI } from '../src/testing.ts';

// docs/specs/api-contract.md, effort routing rows; features/effort-routing.md#설정.

const servers: CorralServer[] = [];
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-effort-routes-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const manifest: D1Manifest = {
  ...LINUX_X64_CPU,
  id: 'd1-route-test',
  model: {
    ...LINUX_X64_CPU.model,
    url: 'https://models.test/d1.gguf',
    size: 5,
    sha256: sha('model'),
  },
  runtime: {
    ...LINUX_X64_CPU.runtime,
    url: 'https://runtime.test/llama.tar.gz',
    size: 7,
    sha256: sha('archive'),
    files: {
      'llama-server': { member: 'llama-b12189/llama-server', size: 6, sha256: sha('server') },
    },
  },
};

function installed(root: string) {
  const dir = join(root, manifest.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, manifest.model.file), 'model');
  writeFileSync(join(dir, 'llama-server'), 'server');
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ id: manifest.id, devices: ['cpu'] }));
}

/** A child that never becomes ready and exits when told to. */
function idleChild(): D1Child {
  let alive = true;
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  return {
    get alive() {
      return alive;
    },
    exited,
    signal: () => {
      alive = false;
      exit();
    },
  };
}

async function start(options: { install?: boolean; live?: boolean } = {}) {
  const workspace = temp();
  const localRoot = temp();
  if (options.install) installed(localRoot);
  const children: D1Child[] = [];
  const downloads: string[] = [];
  const local = new D1Engine({
    root: localRoot,
    manifest,
    launch: () => {
      const child = idleChild();
      children.push(child);
      return child;
    },
    // Every download stays open until the install is cancelled.
    fetchFn: ((url: string | URL | Request, init?: RequestInit) => {
      downloads.push(String(url));
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    }) as typeof fetch,
    freeBytes: async () => null,
  });
  const fake = fakeOpenAI({ configDir: temp() });
  const token = 'test-effort-routing-token-1234567890';
  const server = await startCorralServer({
    workspace,
    ...(options.live === false ? {} : { live: fake.live }),
    localRouting: local,
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  servers.push(server);
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const csrf = login.headers.get('x-corral-csrf') ?? '';
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: {
        origin: server.url,
        cookie,
        ...(method === 'GET' ? {} : { 'x-corral-csrf': csrf }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON
    return { status: response.status, body: (await response.json()) as any };
  };
  return { call, children, downloads, workspace, fake, localRoot, local };
}

const LOCAL: EffortRoutingSettings = {
  mode: 'manual',
  engine: { kind: 'local', device: { kind: 'cpu', threads: 2 }, callerTimeoutMs: 5000 },
  fallback: { kind: 'provider-default' },
};
const jev = (consentRevision = decisionApiConsent('jev')): EffortRoutingSettings => ({
  mode: 'manual',
  engine: { kind: 'api', id: 'jev', callerTimeoutMs: 3000, consentRevision },
  fallback: { kind: 'provider-default' },
});

describe('effort routing routes', () => {
  it('shows Off, the Local engine on the server host, and each API without its key', async () => {
    const s = await start();
    const view = await s.call('/effort-routing');
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      settings: { mode: 'off' },
      revision: expect.any(String),
      local: {
        model: 'd1-2B Q4_K_M',
        host: expect.any(String),
        supported: true,
        install: 'absent',
        runtime: 'stopped',
        downloadBytes: 12,
        device: { requested: 'cpu', active: null },
      },
      apis: [
        { id: 'jev', keyConfigured: false, noticeRevision: 'jev:notice-1', verified: false },
        {
          id: 'openai-decisions',
          keyConfigured: false,
          noticeRevision: 'openai-decisions:notice-1',
          verified: false,
        },
      ],
    });
    expect(JSON.stringify(view.body)).not.toContain(tmpdir());
    expect([s.children.length, s.downloads.length]).toEqual([0, 0]);
  });

  it('saves Local without downloading, and readies an installed engine', async () => {
    const absent = await start();
    const { revision } = (await absent.call('/effort-routing')).body;
    const saved = await absent.call('/effort-routing', 'PUT', { settings: LOCAL, revision });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual(LOCAL);
    expect([absent.children.length, absent.downloads.length]).toEqual([0, 0]);

    const ready = await start({ install: true });
    const current = (await ready.call('/effort-routing')).body.revision;
    await ready.call('/effort-routing', 'PUT', { settings: LOCAL, revision: current });
    expect(ready.children).toHaveLength(1);
    expect((await ready.call('/effort-routing')).body.local.runtime).toBe('starting');
    // Leaving Local ends the child Corral started.
    const again = (await ready.call('/effort-routing')).body.revision;
    await ready.call('/effort-routing', 'PUT', { settings: { mode: 'off' }, revision: again });
    expect(ready.children[0]!.alive).toBe(false);
    expect(ready.downloads).toEqual([]);
  });

  it('refuses a stale revision, an API without its key, and a consent to an old notice', async () => {
    const s = await start();
    const { revision } = (await s.call('/effort-routing')).body;
    expect(
      (await s.call('/effort-routing', 'PUT', { settings: jev(), revision })).body,
    ).toMatchObject({
      error: { code: 'SCHEMA_INVALID' },
    });
    await s.call('/decision-apis/jev/api-key', 'PUT', { key: 'decision-secret-key-0123456789' });
    expect(
      (await s.call('/effort-routing', 'PUT', { settings: jev('jev:notice-0'), revision })).status,
    ).toBe(400);
    const saved = await s.call('/effort-routing', 'PUT', { settings: jev(), revision });
    expect(saved.status).toBe(200);
    expect(saved.body.apis[0]).toMatchObject({ id: 'jev', keyConfigured: true });
    expect(JSON.stringify(saved.body)).not.toContain('decision-secret-key');
    const stale = await s.call('/effort-routing', 'PUT', { settings: LOCAL, revision });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('REVISION_CONFLICT');
    expect((await s.call('/effort-routing')).body.settings).toEqual(jev());
    expect(
      (
        await s.call('/effort-routing', 'PUT', {
          settings: { mode: 'auto' },
          revision: saved.body.revision,
        })
      ).status,
    ).toBe(400);
  });

  it('installs only on request, cancels it, and readies only a saved, installed Local', async () => {
    const s = await start();
    expect((await s.call('/effort-routing/local/start', 'POST')).status).toBe(400);
    const started = await s.call('/effort-routing/local/install', 'POST');
    expect(started.status).toBe(202);
    expect(started.body.local.install).toBe('downloading');
    expect(s.downloads).toEqual([manifest.model.url]);
    expect((await s.call('/effort-routing/local/install', 'POST')).body.local.install).toBe(
      'downloading',
    );
    expect(s.downloads).toHaveLength(1);
    const cancelled = await s.call('/effort-routing/local/install', 'DELETE');
    expect(cancelled.body.local).toMatchObject({ install: 'absent', error: null });

    const ready = await start({ install: true });
    expect((await ready.call('/effort-routing/local/start', 'POST')).status).toBe(400);
    const { revision } = (await ready.call('/effort-routing')).body;
    await ready.call('/effort-routing', 'PUT', { settings: LOCAL, revision });
    expect((await ready.call('/effort-routing/local/start', 'POST')).status).toBe(202);
    expect(ready.children.length).toBeGreaterThanOrEqual(1);
  });

  it('removes only the Local manifest, keeps Manual + Local, and falls back as unavailable', async () => {
    const s = await start({ install: true });
    const meeting = join(s.localRoot, '..', 'corral-local-ai-2');
    mkdirSync(meeting, { recursive: true });
    writeFileSync(join(meeting, 'keep'), 'meeting');
    const { revision } = (await s.call('/effort-routing')).body;
    await s.call('/effort-routing', 'PUT', { settings: LOCAL, revision });

    const removed = await s.call('/effort-routing/local', 'DELETE');
    expect(removed.status).toBe(200);
    expect(removed.body.local.install).toBe('absent');
    expect(removed.body.settings).toEqual(LOCAL);
    expect(existsSync(join(meeting, 'keep'))).toBe(true);
    expect(existsSync(join(s.localRoot, manifest.id))).toBe(false);
    expect(s.children[0]!.alive).toBe(false);
    if (LOCAL.engine.kind !== 'local') throw new Error('expected the Local engine');
    expect(s.local.backend(LOCAL.engine).admit()).toEqual({ ok: false, reason: 'unavailable' });

    const again = await s.call('/effort-routing/local', 'DELETE');
    expect(again.status).toBe(200);
    expect(again.body.local.install).toBe('absent');
    expect(existsSync(join(meeting, 'keep'))).toBe(true);
  });

  it('refuses to remove Local while an install is in progress', async () => {
    const s = await start();
    const meeting = join(s.localRoot, '..', 'corral-local-ai-2');
    mkdirSync(meeting, { recursive: true });
    writeFileSync(join(meeting, 'keep'), 'meeting');
    expect((await s.call('/effort-routing/local/install', 'POST')).body.local.install).toBe(
      'downloading',
    );

    const removed = await s.call('/effort-routing/local', 'DELETE');
    expect(removed.status).toBe(409);
    expect(removed.body.error).toEqual({
      code: 'RESOURCE_CAPACITY',
      message: 'an install is in progress',
    });
    expect((await s.call('/effort-routing')).body.local.install).toBe('downloading');
    expect(s.downloads).toHaveLength(1);
    expect(existsSync(join(meeting, 'keep'))).toBe(true);
  });

  it('is refused on a server without real models', async () => {
    const s = await start({ live: false });
    for (const [path, method] of [
      ['/effort-routing', 'GET'],
      ['/effort-routing', 'PUT'],
      ['/effort-routing/local/install', 'POST'],
      ['/effort-routing/local/install', 'DELETE'],
      ['/effort-routing/local', 'DELETE'],
      ['/effort-routing/local/start', 'POST'],
    ] as const) {
      const response = await s.call(path, method, method === 'GET' ? undefined : {});
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CAPABILITY_DENIED');
    }
    expect(s.downloads).toEqual([]);
  });
});
