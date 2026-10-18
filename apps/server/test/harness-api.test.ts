import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processChannel } from '@corral/adapter-pi';
import { InProcessTransport, waitForProjection } from '@corral/core';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/app.ts';
import { fakeOpenAI } from '../src/testing.ts';
import { oauthFixture } from './fixtures/mcp-oauth.ts';

let server: CorralServer | undefined;
let root: string;
it('[TC-HAR-016-H] [TC-MGR-002-H] [TC-MGR-002-N] binds browser OAuth to reviewed settings and allows logout after trust revocation', async () => {
  root = mkdtempSync(join(tmpdir(), 'corral-mcp-api-'));
  const source = join(root, 'source');
  execFileSync('git', ['init', '-q', source]);
  const fixture = await oauthFixture();
  const token = 'mcp-bootstrap-0123456789abcdef';
  const { live } = fakeOpenAI({ configDir: join(root, 'private') });
  try {
    server = await startCorralServer({
      workspace: join(root, 'workspace'),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      bootstrapToken: token,
      live,
    });
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const headers = {
      cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      origin: server.url,
      'content-type': 'application/json',
      'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    };
    const call = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
      const response = await fetch(`${server?.url}/api/v1${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    await call('/projects/default/workspace', { path: source }, 'PUT');
    await call('/projects/default/workspace', { trusted: true }, 'PATCH');
    const config = {
      checks: [],
      lspServers: [],
      mcpServers: [
        {
          id: 'docs',
          name: 'Docs',
          transport: 'http',
          url: fixture.url,
          timeoutMs: 5000,
          exposure: 'direct',
          auth: { kind: 'oauth', scope: 'docs:read', credentialRef: 'login' },
        },
      ],
    };
    const { id: _id, auth: _auth, ...draft } = config.mcpServers[0]!;
    const createRequest = {
      expectedRevision: 0,
      operationId: 'create-docs',
      draft: { ...draft, enabled: true, auth: { kind: 'oauth', scope: 'docs:read' } },
    };
    const created = await call('/harness/projects/default/mcp', createRequest);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const serverId = created.body.mcpServers[0].id;
    const path = `/harness/projects/default/mcp-servers/${serverId}`;
    const { fingerprint } = (await call(`${path}/launch`)).body;
    expect((await call(`${path}/auth`, { action: 'sign_in', fingerprint })).status).toBe(400);
    await call(`${path}/trust`, { fingerprint, trusted: true }, 'PUT');
    const started = await call(`${path}/auth`, { action: 'sign_in', fingerprint });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await fetch(started.body.url);
    await expect
      .poll(async () => (await call(`/harness/mcp-logins/${started.body.loginId}`)).body.state)
      .toBe('ready');
    const status = await call(`${path}/auth`);
    expect(status.body).toMatchObject({ state: 'ready', kind: 'oauth' });
    expect(JSON.stringify(status.body)).not.toContain('fixture-access');
    // TC-MGR-002-H: diagnostics use the real protocol without executing a tool or a model.
    const probe = await call(`${path}/probe`, {
      operationId: 'probe-docs',
      configRevision: 1,
      fingerprint,
    });
    expect(probe.status, JSON.stringify(probe.body)).toBe(200);
    expect(probe.body.tools[0]?.name).toBe(`mcp__${serverId}__echo`);
    expect(fixture.mcpCalls).toBe(0);
    expect((await call('/harness/mcp-probes/late-probe', {}, 'DELETE')).status).toBe(200);
    const lateProbe = await call(`${path}/probe`, {
      operationId: 'late-probe',
      configRevision: 1,
      fingerprint,
    });
    expect(lateProbe.status).toBe(400);
    expect(lateProbe.body.error.message).toBe('MCP probe cancelled');

    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.delayTools(async () => {
      entered();
      await gate;
    });
    let probeFinished = false;
    const pending = call(`${path}/probe`, {
      operationId: 'probe-cancel',
      configRevision: 1,
      fingerprint,
    }).then((value) => {
      probeFinished = true;
      return value;
    });
    await waiting;
    expect((await call('/harness/projects/default/mcp', createRequest)).status).toBe(200);
    expect(probeFinished).toBe(false);
    expect(
      (
        await call('/harness/projects/default/mcp', {
          ...createRequest,
          draft: { ...createRequest.draft, name: 'Different' },
        })
      ).status,
    ).toBe(400);
    expect(probeFinished).toBe(false);
    expect(
      (await call('/harness/projects/default/mcp', { ...createRequest, operationId: 'stale-save' }))
        .status,
    ).toBe(409);
    expect(probeFinished).toBe(false);

    expect((await call('/harness/mcp-probes/probe-cancel', {}, 'DELETE')).status).toBe(200);
    release();
    fixture.delayTools();
    expect((await pending).body.error.message).toBe('MCP probe cancelled');
    const update = await call(
      '/harness/projects/default/tools',
      {
        expectedRevision: 1,
        config: {
          checks: [],
          lspServers: [],
          mcpServers: [
            {
              ...created.body.mcpServers[0],
              auth: { ...created.body.mcpServers[0].auth, scope: 'docs:write' },
            },
          ],
        },
      },
      'PUT',
    );
    expect(update.status).toBe(200);
    expect(update.body.mcpServers[0].auth.credentialRef).not.toBe(
      created.body.mcpServers[0].auth.credentialRef,
    );
    const current = (await call(`${path}/launch`)).body;
    await call(`${path}/trust`, { fingerprint: current.fingerprint, trusted: true }, 'PUT');
    fixture.scope('docs:write');
    const loginNext = await call(`${path}/auth`, {
      action: 'sign_in',
      fingerprint: current.fingerprint,
    });
    await fetch(loginNext.body.url);
    await expect
      .poll(async () => (await call(`/harness/mcp-logins/${loginNext.body.loginId}`)).body.state)
      .toBe('ready');
    expect((await call('/harness/projects/default/mcp-history')).body).toContainEqual(
      expect.objectContaining({
        configRevision: 1,
        canRestore: false,
        server: expect.objectContaining({
          auth: expect.objectContaining({
            credentialRef: created.body.mcpServers[0].auth.credentialRef,
          }),
        }),
      }),
    );
    expect((await call(`${path}/auth`, { action: 'sign_out', fingerprint })).status).toBe(409);
    expect(
      (await call(`${path}/auth`, { action: 'sign_out', fingerprint, configRevision: 1 })).status,
    ).toBe(200);
    expect((await call(`${path}/auth`)).body.state).toBe('ready');
    await call(`${path}/trust`, { fingerprint: current.fingerprint, trusted: false }, 'PUT');
    expect(
      (await call(`${path}/auth`, { action: 'sign_out', fingerprint: current.fingerprint })).status,
    ).toBe(200);
    expect((await call(`${path}/auth`)).body.state).toBe('missing');
  } finally {
    await fixture.close();
  }
});
it('[TC-HAR-003-H] simulates a bound work style without claiming that its SDK resources were loaded', async () => {
  root = mkdtempSync(join(tmpdir(), 'corral-harness-simulation-'));
  const token = 'simulation-bootstrap-0123456789abcdef';
  server = await startCorralServer({
    workspace: root,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    bootstrapToken: token,
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const headers = {
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    origin: server.url,
    'content-type': 'application/json',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
  };
  expect(
    (
      await fetch(`${server.url}/api/v1/harness/profiles/sample`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          expectedRevision: 0,
          profile: {
            name: 'Sample',
            policy: 'strict',
            resources: [],
            allowedTools: ['write_artifact', 'submit_result'],
            startupCommands: [],
          },
        }),
      })
    ).status,
  ).toBe(200);
  const definition = linearCorral(['writer']);
  definition.roles[0]!.harness = { profileId: 'sample', revision: 1 };
  const transport = new InProcessTransport(server.coordinator);
  const started = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'simulate',
    definition,
    mode: 'mock',
  });
  expect(started.runId).toBeTruthy();
  const id = started.runId!;
  const events: string[] = [];
  const off = transport.subscribe(id, 0, { onEvent: (event) => events.push(event.type) });
  const final = await waitForProjection(transport, id, (p) =>
    ['succeeded', 'failed', 'cancelled'].includes(p.status),
  );
  off();
  expect(final.status).toBe('succeeded');
  expect(events).toContain('harness.simulated');
  expect(events).not.toContain('harness.loaded');
  expect(events).not.toContain('model.request_recorded');
});
it.skipIf(process.platform !== 'linux')(
  '[TC-HAR-017-N] server startup reaps the previous SDK owner before accepting work',
  async () => {
    root = mkdtempSync(join(tmpdir(), 'corral-server-recovery-'));
    const workspace = join(root, 'workspace');
    const worker = processChannel(
      join(import.meta.dirname, '../../../packages/adapter-pi/test/fixtures/orphan-worker.ts'),
      { leaseDirectory: join(workspace, '.corral', 'sdk-workers') },
    );
    let ended = false;
    const exited = new Promise<void>((resolve) =>
      worker.onExit(() => {
        ended = true;
        resolve();
      }),
    );
    try {
      await new Promise<void>((resolve) => worker.onFrame(() => resolve()));
      server = await startCorralServer({
        workspace,
        agents: new ScriptedAgentAdapter({ turns: 1 }),
      });
      await exited;
      expect(ended).toBe(true);
    } finally {
      worker.kill();
      await exited;
    }
  },
);
afterEach(async () => {
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

it.each(['check', 'lsp'] as const)(
  '[TC-HAR-012-H] [TC-HAR-012-N] project %s settings and trust use guarded immutable revisions and exact launch hashes',
  async (kind) => {
    root = mkdtempSync(join(tmpdir(), 'corral-tools-api-'));
    const source = join(root, 'source');
    execFileSync('git', ['init', '-q', source]);
    writeFileSync(join(source, 'check.mjs'), 'process.exit(0)');
    const token = 'project-tools-bootstrap-0123456789abcdef';
    server = await startCorralServer({
      workspace: join(root, 'workspace'),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      bootstrapToken: token,
    });
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const headers = {
      cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      origin: server.url,
      'content-type': 'application/json',
      'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    };
    const call = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
      const response = await fetch(`${server?.url}/api/v1${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const config = {
      checks: [{ id: 'types', name: 'Types', argv: ['node', 'check.mjs'], timeoutMs: 10000 }],
      lspServers: [
        {
          id: 'types',
          name: 'Types',
          argv: ['node', 'check.mjs'],
          timeoutMs: 10000,
          languageIds: ['typescript'],
          fileExtensions: ['.ts'],
        },
      ],
    };
    expect((await call('/harness/projects/default/tools')).body).toBeNull();
    expect(
      (await call('/harness/projects/default/tools', { expectedRevision: 0, config }, 'PUT'))
        .status,
    ).toBe(400);
    expect((await call('/projects/default/workspace', { path: source }, 'PUT')).status).toBe(201);
    expect((await call('/projects/default/workspace', { trusted: true }, 'PATCH')).status).toBe(
      200,
    );
    const saved = await call(
      '/harness/projects/default/tools',
      { expectedRevision: 0, config },
      'PUT',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.revision).toBe(1);
    const criteria = await call('/harness/projects/default/criteria-files', {
      paths: ['check.mjs'],
    });
    expect(criteria.status).toBe(200);
    expect(criteria.body).toEqual([
      { path: 'check.mjs', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect(JSON.stringify(criteria.body)).not.toContain(source);
    expect(
      (await call('/harness/projects/default/criteria-files', { paths: ['../check.mjs'] })).status,
    ).toBe(400);
    expect(
      (await call('/harness/projects/default/tools', { expectedRevision: 0, config }, 'PUT'))
        .status,
    ).toBe(409);
    const path = `/harness/projects/default/${kind === 'check' ? 'checks' : 'lsp-servers'}/types`;
    const launch = await call(`${path}/launch`);
    expect(launch.status).toBe(200);
    expect(launch.body.trustedAt).toBeNull();
    expect(JSON.stringify(launch.body)).not.toContain(source);
    const trusted = await call(
      `${path}/trust`,
      { fingerprint: launch.body.fingerprint, trusted: true },
      'PUT',
    );
    expect(trusted.status).toBe(200);
    expect(trusted.body.trustedAt).not.toBeNull();
    const other = await call(
      `/harness/projects/default/${kind === 'check' ? 'lsp-servers' : 'checks'}/types/launch`,
    );
    expect(other.status).toBe(200);
    expect(other.body.trustedAt).toBeNull();
    writeFileSync(join(source, 'check.mjs'), 'process.exit(1)');
    const changed = await call(`${path}/launch`);
    expect(changed.body.fingerprint).not.toBe(launch.body.fingerprint);
    expect(changed.body.trustedAt).toBeNull();
    expect(
      (await call(`${path}/trust`, { fingerprint: launch.body.fingerprint, trusted: true }, 'PUT'))
        .status,
    ).toBe(409);
    await call(
      '/harness/projects/default/tools',
      { expectedRevision: 1, config: { checks: [], lspServers: [] } },
      'PUT',
    );
    expect((await call('/projects/default/workspace')).body.binding.verifyCommands).toEqual([]);
  },
);

it('[TC-HAR-004-H] [TC-HAR-004-N] resource API requires review and trust, pins revisions and protects local paths', async () => {
  root = mkdtempSync(join(tmpdir(), 'corral-harness-api-'));
  const source = join(root, 'source');
  const marker = join(root, 'executed');
  mkdirSync(source);
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', pi: { extensions: ['./extension.ts'] } }),
  );
  writeFileSync(
    join(source, 'extension.ts'),
    `import {writeFileSync} from 'node:fs'; export default ()=>writeFileSync(${JSON.stringify(marker)}, 'bad');`,
  );
  const token = 'harness-api-bootstrap-0123456789abcdef';
  server = await startCorralServer({
    workspace: join(root, 'workspace'),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    bootstrapToken: token,
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const headers = {
    cookie,
    origin: server.url,
    'content-type': 'application/json',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
  };
  const call = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${server?.url}/api/v1/harness${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  expect((await fetch(`${server.url}/api/v1/harness/resources`)).status).toBe(401);
  expect((await call('/resources')).body).toEqual([]);
  const reviewed = await call('/reviews', { source, kind: 'local' });
  expect(reviewed.status).toBe(200);
  expect(JSON.stringify(reviewed.body)).not.toContain(source);
  expect(existsSync(marker)).toBe(false);
  expect((await call('/resources')).body).toEqual([]);
  const installed = await call('/resources', { reviewId: reviewed.body.reviewId });
  expect(installed.body.trustedAt).toBeNull();
  expect((await call('/resources', { reviewId: reviewed.body.reviewId })).body).toEqual(
    installed.body,
  );
  const profile = {
    name: 'Writer',
    policy: 'trusted-native',
    resources: [
      {
        resourceHash: installed.body.hash,
        entry: 'extension.ts',
        kind: 'extension',
        required: true,
      },
    ],
    allowedTools: ['write_artifact', 'submit_result'],
    startupCommands: [],
  };
  expect((await call('/profiles/writer', { expectedRevision: 0, profile }, 'PUT')).status).toBe(
    400,
  );
  expect(
    (await call(`/resources/${installed.body.hash}/trust`, { trusted: true }, 'PUT')).status,
  ).toBe(200);
  const saved = await call('/profiles/writer', { expectedRevision: 0, profile }, 'PUT');
  expect(saved.body.revision).toBe(1);
  expect((await call('/profiles/writer', { expectedRevision: 0, profile }, 'PUT')).status).toBe(
    409,
  );
  const binding = { profileId: 'writer', revision: 1 };
  const preview = await call('/preview', { binding, projectId: 'default' });
  expect(preview.body.snapshot.binding).toEqual(binding);
  expect(preview.body.dynamic).toBe(true);
  expect(existsSync(marker)).toBe(false);
  expect(
    (await call('/defaults/personal/default', { expectedRevision: 0, binding }, 'PUT')).body
      .binding,
  ).toEqual(binding);
  expect((await call('/defaults/personal/default')).body.revision).toBe(1);
  await call(
    '/profiles/strict',
    { expectedRevision: 0, profile: { ...profile, policy: 'strict', resources: [] } },
    'PUT',
  );
  expect(
    (
      await call(
        '/defaults/personal/default',
        { expectedRevision: 1, binding: { profileId: 'strict', revision: 1 } },
        'PUT',
      )
    ).status,
  ).toBe(200);
  // Replacing a personal default does not inherit the default being replaced.
  expect(
    (await call('/defaults/personal/default', { expectedRevision: 2, binding }, 'PUT')).status,
  ).toBe(200);
  const missing = await call('/reviews', { source: join(root, 'private-name'), kind: 'local' });
  expect(missing.status).toBe(400);
  expect(JSON.stringify(missing.body)).not.toContain(root);
});
