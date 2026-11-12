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
import { DecisionApis } from '../src/decision-apis.ts';
import { startCorralServer } from '../src/index.ts';
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

async function serve(
  localIntelligence: LocalIntelligence | undefined,
  decisionApis?: DecisionApis,
) {
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
    ...(decisionApis ? { decisionApis } : {}),
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
          models: { meeting: bundle.models.meeting.name },
          state: 'missing',
          downloadBytes: bundle.models.meeting.size + runtimeSize,
          progress: null,
          error: null,
          device: { requested: 'cpu', actual: null },
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
      expect(held.requested).toEqual([bundle.models.meeting.url]);

      expect(await call('/local-ai/install', 'DELETE')).toMatchObject({
        status: 200,
        body: { state: 'missing', progress: null, error: null },
      });
      expect(held.aborted).toEqual([bundle.models.meeting.url]);
      expect(existsSync(join(bundleDir(dataRoot, bundle), 'install.json'))).toBe(false);

      expect(await call('/local-ai/install', 'POST')).toMatchObject({ status: 202 });
    } finally {
      await server.close();
    }
    expect(held.aborted).toEqual([bundle.models.meeting.url, bundle.models.meeting.url]);
  },
);

it('refuses to install where local AI cannot run, and a server without it reports it unsupported', async () => {
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
  // A server started without the engine reads like an environment that cannot run it.
  const none = await serve(undefined);
  try {
    expect(await none.call('/local-ai')).toEqual({
      status: 200,
      body: {
        release: bundle.release,
        models: { meeting: bundle.models.meeting.name },
        state: 'unsupported',
        downloadBytes: null,
        progress: null,
        error: null,
        device: { requested: 'cpu', actual: null },
      },
    });
    for (const method of ['POST', 'DELETE'])
      expect(await none.call('/local-ai/install', method)).toMatchObject({
        status: 403,
        body: { error: { code: 'CAPABILITY_DENIED' } },
      });
  } finally {
    await none.server.close();
  }
});

it('connects decision APIs by key, never returning the key', async () => {
  const KEY = 'decision-secret-key-0123456789';
  const dataRoot = mkdtempSync(join(tmpdir(), 'corral-local-ai-data-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'corral-local-ai-keys-'));
  dirs.push(dataRoot, keyDir);
  const { server, call } = await serve(
    createLocalIntelligence({ root: dataRoot, env: {}, launch: neverReady }),
    await DecisionApis.open({ credentials: new FileCredentialStore(keyDir) }),
  );
  try {
    expect(await call('/decision-apis')).toEqual({
      status: 200,
      body: [
        { id: 'jev', provider: 'TypeSafe', model: 'jev-latest', keyConfigured: false },
        { id: 'openai-decisions', provider: 'OpenAI', model: 'gpt-6-luna', keyConfigured: false },
      ],
    });
    const saved = await call('/decision-apis/openai-decisions/api-key', 'PUT', { key: KEY });
    expect(saved).toMatchObject({
      status: 200,
      body: [
        { id: 'jev', keyConfigured: false },
        { id: 'openai-decisions', keyConfigured: true },
      ],
    });
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    expect(await call('/decision-apis/openai-decisions/api-key', 'PUT', { key: '' })).toMatchObject(
      { status: 400 },
    );
    expect(await call('/decision-apis/bogus/api-key', 'PUT', { key: KEY })).toMatchObject({
      status: 404,
    });

    expect(JSON.stringify((await call('/local-ai')).body)).not.toContain(KEY);
    // The removed judge settings have no route.
    expect(await call('/local-ai/external-judge', 'PUT', { provider: null })).toMatchObject({
      status: 404,
    });
    expect(await call('/models/reasoning')).toMatchObject({ status: 404 });

    expect(await call('/decision-apis/openai-decisions/api-key', 'DELETE')).toMatchObject({
      status: 200,
      body: [{ id: 'jev' }, { id: 'openai-decisions', keyConfigured: false }],
    });
    expect(readFileSync(join(keyDir, 'credentials.json'), 'utf8')).not.toContain(KEY);
  } finally {
    await server.close();
  }
});

it('stores no decision API key on a server without real models', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'corral-local-ai-data-'));
  dirs.push(dataRoot);
  const { server, call } = await serve(
    createLocalIntelligence({ root: dataRoot, env: {}, launch: neverReady }),
  );
  try {
    expect(await call('/decision-apis')).toMatchObject({
      status: 200,
      body: [
        { id: 'jev', keyConfigured: false },
        { id: 'openai-decisions', keyConfigured: false },
      ],
    });
    expect(
      await call('/decision-apis/jev/api-key', 'PUT', { key: 'decision-secret-key-0123456789' }),
    ).toMatchObject({ status: 403, body: { error: { code: 'CAPABILITY_DENIED' } } });
  } finally {
    await server.close();
  }
});

it.skipIf(!target)(
  'local AI status sees a bundle installed while the server runs; nothing starts the helper',
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
    launches.length = 0;
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
      const status = async () =>
        (await (
          await fetch(`${server.url}/api/v1/local-ai`, { headers: { origin: server.url, cookie } })
        ).json()) as { state: string };

      expect(await status()).toMatchObject({ state: 'missing' });
      mkdirSync(bundleDir(dataRoot, bundle), { recursive: true });
      writeFileSync(
        join(bundleDir(dataRoot, bundle), 'install.json'),
        JSON.stringify({ release: bundle.release, target }),
      );
      expect(await status()).toMatchObject({ state: 'idle' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(launches).toEqual([]);
    } finally {
      await server.close();
      launches.length = 0;
    }
    expect(localIntelligence.engine.available()).toMatch(/closed/);
  },
);

it.skipIf(!target)(
  'removes only the meeting bundle and refuses while an install or a computation is running',
  async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'corral-local-ai-data-'));
    dirs.push(dataRoot);
    const judge = join(dataRoot, 'd1', 'd1-test');
    mkdirSync(judge, { recursive: true });
    writeFileSync(join(judge, 'keep'), 'judge');
    const held = heldFetch();
    const installing = createLocalIntelligence({
      root: dataRoot,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/corral-helper' },
      launch: neverReady,
      fetchFn: held.fetchFn,
    });
    const duringInstall = await serve(installing);
    try {
      expect((await duringInstall.call('/local-ai/install', 'POST')).body).toMatchObject({
        state: 'installing',
      });
      const refused = await duringInstall.call('/local-ai', 'DELETE');
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: { code: 'RESOURCE_CAPACITY', message: 'an install is in progress' },
      });
      expect(held.aborted).toEqual([]);
      expect(existsSync(join(judge, 'keep'))).toBe(true);
    } finally {
      await duringInstall.server.close();
    }

    const installed = createLocalIntelligence({
      root: dataRoot,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/corral-helper' },
      launch: neverReady,
    });
    mkdirSync(bundleDir(dataRoot, bundle), { recursive: true });
    writeFileSync(
      join(bundleDir(dataRoot, bundle), 'install.json'),
      JSON.stringify({ release: bundle.release, target }),
    );
    expect(installed.status().state).toBe('idle');
    const pending = installed.engine.embed({
      texts: ['hi'],
      task: 'classification',
      overflow: 'truncate',
    });
    const busy = await serve(installed);
    try {
      const refused = await busy.call('/local-ai', 'DELETE');
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: { code: 'RESOURCE_CAPACITY', message: 'a computation is in progress' },
      });
      expect(existsSync(join(bundleDir(dataRoot, bundle), 'install.json'))).toBe(true);
      expect(existsSync(join(judge, 'keep'))).toBe(true);
    } finally {
      pending.catch(() => {});
      await busy.server.close();
    }

    const idle = createLocalIntelligence({
      root: dataRoot,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/corral-helper' },
      launch: neverReady,
    });
    const done = await serve(idle);
    try {
      const removed = await done.call('/local-ai', 'DELETE');
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ state: 'missing', progress: null, error: null });
      expect(existsSync(bundleDir(dataRoot, bundle))).toBe(false);
      expect(existsSync(join(judge, 'keep'))).toBe(true);
      const again = await done.call('/local-ai', 'DELETE');
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ state: 'missing' });
      expect(existsSync(join(judge, 'keep'))).toBe(true);
    } finally {
      await done.server.close();
    }
  },
);

it('saves the meeting device and restores it for the next engine', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'corral-local-ai-data-'));
  dirs.push(dataRoot);
  const options = {
    root: dataRoot,
    env: { CORRAL_LOCAL_AI_HELPER: '/opt/corral-helper' },
    launch: neverReady,
    platform: 'linux' as const,
    arch: 'x64' as const,
  };
  const { server, call } = await serve(createLocalIntelligence(options));
  try {
    expect((await call('/local-ai')).body).toMatchObject({
      device: { requested: 'cpu', actual: null },
    });
    const saved = await call('/local-ai/device', 'PUT', { device: 'gpu' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ device: { requested: 'gpu', actual: null } });
  } finally {
    await server.close();
  }
  const again = createLocalIntelligence(options);
  expect(again.status().device).toEqual({ requested: 'gpu', actual: null });
  await again.close();
});

it.skipIf(!target)(
  'refuses a meeting device change while a computation is running and keeps the device',
  async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'corral-local-ai-data-'));
    dirs.push(dataRoot);
    const options = {
      root: dataRoot,
      env: { CORRAL_LOCAL_AI_HELPER: '/opt/corral-helper' },
      launch: neverReady,
    };
    mkdirSync(bundleDir(dataRoot, bundle), { recursive: true });
    writeFileSync(
      join(bundleDir(dataRoot, bundle), 'install.json'),
      JSON.stringify({ release: bundle.release, target }),
    );
    const local = createLocalIntelligence(options);
    expect(local.status().state).toBe('idle');
    let settled = false;
    const pending = local.engine
      .embed({ texts: ['hi'], task: 'classification', overflow: 'truncate' })
      .finally(() => {
        settled = true;
      });
    pending.catch(() => {});
    const { server, call } = await serve(local);
    try {
      const refused = await call('/local-ai/device', 'PUT', { device: 'gpu' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: { code: 'RESOURCE_CAPACITY', message: 'a computation is in progress' },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      expect((await call('/local-ai')).body).toMatchObject({ device: { requested: 'cpu' } });
      // Choosing the device already saved is not a change.
      expect((await call('/local-ai/device', 'PUT', { device: 'cpu' })).status).toBe(200);
      expect(settled).toBe(false);
    } finally {
      await server.close();
      launches.length = 0;
    }
    const again = createLocalIntelligence(options);
    expect(again.status().device.requested).toBe('cpu');
    await again.close();
  },
);
