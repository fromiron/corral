import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleDir,
  bundledManifest,
  createLocalIntelligence,
  type HelperLauncher,
  type LocalIntelligence,
  runtimeTarget,
} from '@corral/local-intelligence';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { startCorralServer } from '../src/index.ts';
import { JevJudge } from '../src/jev.ts';
import { FileCredentialStore } from '../src/models/credential-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bundle = bundledManifest();
const target = runtimeTarget(bundle, process.platform, process.arch);
const launches: string[] = [];
const neverReady: HelperLauncher = (command) => {
  launches.push(command.executable);
  return { write() {}, onLine() {}, onExit() {}, kill: async () => {} };
};

async function serve(localIntelligence: LocalIntelligence | undefined, externalJudge?: JevJudge) {
  const root = mkdtempSync(join(tmpdir(), 'corral-local-ai-'));
  dirs.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.corral'), { recursive: true });
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({ schemaVersion: '0.1' }),
  );
  const token = 'test-bootstrap-token-0123456789abcdef';
  const server = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken: token,
    worktreeRoot: join(root, 'worktrees'),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    ...(localIntelligence ? { localIntelligence } : {}),
    ...(externalJudge ? { externalJudge } : {}),
  });
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
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { server, call, root };
}

/** Holds each download until the install is cancelled. */
function heldFetch() {
  const requested: string[] = [];
  const aborted: string[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    requested.push(String(input));
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener('abort', () => {
        aborted.push(String(input));
        reject(init.signal?.reason);
      }),
    );
  }) as typeof fetch;
  return { fetchFn, requested, aborted };
}

it.skipIf(!target)(
  'the settings panel installs through the server once, and cancel or shutdown stops it',
  async () => {
    const held = heldFetch();
    const dataRoot = mkdtempSync(join(tmpdir(), 'corral-local-ai-data-'));
    dirs.push(dataRoot);
    const localIntelligence = createLocalIntelligence({
      root: dataRoot,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/corral-helper' },
      launch: neverReady,
      fetchFn: held.fetchFn,
    });
    const { server, call } = await serve(localIntelligence);
    try {
      const runtimeSize = target ? (bundle.runtime.targets[target]?.size ?? 0) : 0;
      expect(await call('/local-ai')).toEqual({
        status: 200,
        body: {
          release: bundle.release,
          modelName: bundle.model.name,
          state: 'missing',
          downloadBytes: bundle.model.size + runtimeSize,
          progress: null,
          error: null,
          external: expect.objectContaining({ provider: 'jev', enabled: false }),
        },
      });
      expect(await call('/local-ai/install', 'POST')).toMatchObject({
        status: 202,
        body: { state: 'installing', progress: { received: 0 } },
      });
      expect(await call('/local-ai/install', 'POST')).toMatchObject({
        status: 202,
        body: { state: 'installing' },
      });
      expect(held.requested).toEqual([bundle.model.url]);

      expect(await call('/local-ai/install', 'DELETE')).toMatchObject({
        status: 200,
        body: { state: 'missing', progress: null, error: null },
      });
      expect(held.aborted).toEqual([bundle.model.url]);
      expect(existsSync(join(bundleDir(dataRoot, bundle), 'install.json'))).toBe(false);

      expect(await call('/local-ai/install', 'POST')).toMatchObject({ status: 202 });
    } finally {
      await server.close();
    }
    expect(held.aborted).toEqual([bundle.model.url, bundle.model.url]);
  },
);

it('refuses to install where local AI cannot run, and a server without it says so', async () => {
  const held = heldFetch();
  const dataRoot = mkdtempSync(join(tmpdir(), 'corral-local-ai-data-'));
  dirs.push(dataRoot);
  const unsupported = await serve(
    createLocalIntelligence({
      root: dataRoot,
      env: {},
      launch: neverReady,
      fetchFn: held.fetchFn,
      platform: 'freebsd',
      arch: 'x64',
    }),
  );
  try {
    expect(await unsupported.call('/local-ai')).toMatchObject({
      status: 200,
      body: { state: 'unsupported', downloadBytes: null },
    });
    expect(await unsupported.call('/local-ai/install', 'POST')).toMatchObject({
      status: 403,
      body: { error: { code: 'CAPABILITY_DENIED' } },
    });
    expect(held.requested).toEqual([]);
  } finally {
    await unsupported.server.close();
  }
  const none = await serve(undefined);
  try {
    expect(await none.call('/local-ai')).toMatchObject({
      status: 403,
      body: { error: { code: 'CAPABILITY_DENIED' } },
    });
  } finally {
    await none.server.close();
  }
});

it('stores the TypeSafe key and the workspace Jev setting, and never returns the key', async () => {
  const KEY = 'ts-secret-key-0123456789';
  const dataRoot = mkdtempSync(join(tmpdir(), 'corral-local-ai-data-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'corral-local-ai-keys-'));
  dirs.push(dataRoot, keyDir);
  const { server, call, root } = await serve(
    createLocalIntelligence({ root: dataRoot, env: {}, launch: neverReady }),
    await JevJudge.open({ credentials: new FileCredentialStore(keyDir) }),
  );
  const config = () =>
    JSON.parse(readFileSync(join(root, 'workspace', '.corral', 'config.json'), 'utf8')) as {
      decisions?: { reasoning_effort: Record<string, unknown> };
    };
  try {
    const first = await call('/local-ai');
    expect(first.body.external).toEqual({
      provider: 'jev',
      model: 'jev-latest',
      enabled: false,
      keyConfigured: false,
      revision: expect.any(String),
    });
    const { revision } = first.body.external as { revision: string };

    const saved = await call('/local-ai/external-judge/api-key', 'PUT', { key: KEY });
    expect(saved).toMatchObject({ status: 200, body: { external: { keyConfigured: true } } });
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    expect(JSON.stringify((await call('/local-ai')).body)).not.toContain(KEY);
    expect(await call('/local-ai/external-judge/api-key', 'PUT', { key: '' })).toMatchObject({
      status: 400,
    });

    expect(
      await call('/local-ai/external-judge', 'PUT', { enabled: true, revision: 'stale' }),
    ).toMatchObject({ status: 409 });
    expect(config().decisions).toBeUndefined();
    const enabled = await call('/local-ai/external-judge', 'PUT', { enabled: true, revision });
    expect(enabled).toMatchObject({ status: 200, body: { external: { enabled: true } } });
    expect(config().decisions?.reasoning_effort).toMatchObject({
      allowExternal: true,
      external: { provider: 'jev', model: 'jev-latest' },
    });

    // Turning automatic reasoning on keeps the Jev setting.
    const reasoning = await call('/models/reasoning');
    await call('/models/reasoning', 'PUT', { apply: true, revision: reasoning.body.revision });
    expect(config().decisions?.reasoning_effort).toMatchObject({
      apply: true,
      allowExternal: true,
      external: { provider: 'jev' },
    });

    const off = await call('/local-ai/external-judge', 'PUT', {
      enabled: false,
      revision: ((await call('/local-ai')).body.external as { revision: string }).revision,
    });
    expect(off).toMatchObject({ status: 200, body: { external: { enabled: false } } });
    expect(config().decisions?.reasoning_effort).toMatchObject({ allowExternal: false });
    expect(config().decisions?.reasoning_effort.external).toBeUndefined();

    expect(await call('/local-ai/external-judge/api-key', 'DELETE')).toMatchObject({
      status: 200,
      body: { external: { keyConfigured: false } },
    });
    expect(readFileSync(join(keyDir, 'credentials.json'), 'utf8')).not.toContain(KEY);
  } finally {
    await server.close();
  }
});

it.skipIf(!target)(
  'reasoning settings see a bundle installed while the server runs, and stopping closes the engine',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'corral-local-ai-'));
    dirs.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, '.corral'), { recursive: true });
    writeFileSync(
      join(workspace, '.corral', 'config.json'),
      JSON.stringify({ schemaVersion: '0.1' }),
    );
    const dataRoot = join(root, 'local-ai');
    const localIntelligence = createLocalIntelligence({
      root: dataRoot,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/corral-helper' },
      launch: neverReady,
    });
    const token = 'test-bootstrap-token-0123456789abcdef';
    const server = await startCorralServer({
      workspace,
      port: 0,
      bootstrapToken: token,
      worktreeRoot: join(root, 'worktrees'),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      localIntelligence,
    });
    try {
      const login = await fetch(`${server.url}/api/v1/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: server.url },
        body: JSON.stringify({ token }),
      });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const settings = async () =>
        (await (
          await fetch(`${server.url}/api/v1/models/reasoning`, {
            headers: { origin: server.url, cookie },
          })
        ).json()) as { available: boolean; version: string | null; reason: string | null };

      expect(await settings()).toMatchObject({ available: false });
      expect((await settings()).reason).toContain('corral local-ai install');

      mkdirSync(bundleDir(dataRoot, bundle), { recursive: true });
      writeFileSync(
        join(bundleDir(dataRoot, bundle), 'install.json'),
        JSON.stringify({ release: bundle.release, target }),
      );
      expect(await settings()).toMatchObject({
        available: true,
        version: `${bundle.release}+effort-v1`,
        reason: null,
      });
      expect(launches).toEqual([]);
    } finally {
      await server.close();
    }
    expect(localIntelligence.effort.available()).toMatch(/closed/);
  },
);
