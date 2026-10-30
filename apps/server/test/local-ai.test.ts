import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function serve(localIntelligence: LocalIntelligence | undefined) {
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
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const csrf = login.headers.get('x-corral-csrf') ?? '';
  const call = async (path: string, method = 'GET') => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: {
        origin: server.url,
        cookie,
        ...(method === 'GET' ? {} : { 'x-corral-csrf': csrf }),
      },
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
