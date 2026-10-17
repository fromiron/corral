import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/app.ts';

let server: CorralServer | undefined;
let root: string;
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
  expect((await call('/resources', { reviewId: reviewed.body.reviewId })).status).toBe(400);
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
