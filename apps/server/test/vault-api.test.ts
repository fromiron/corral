import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import { fakeOpenAI } from '../src/testing.ts';
import { decryptVault } from '../src/vault/crypto.ts';

const servers: CorralServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-vault-api-'));
  dirs.push(dir);
  return dir;
};
const password = 'explicit local test vault password';
const application = { version: 1, theme: 'dark', locale: 'en', sendKey: 'enter', notify: false };
async function start() {
  const fake = fakeOpenAI({ configDir: temp() });
  const token = 'vault-bootstrap-fixture-1234567890';
  const server = await startCorralServer({
    workspace: temp(),
    port: 0,
    live: fake.live,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  servers.push(server);
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: server.url,
    },
    body: JSON.stringify({ token }),
  });
  const headers = {
    'content-type': 'application/json',
    origin: server.url,
    cookie: login.headers.get('set-cookie')?.split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
  };
  return async function call(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      headers,
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
}
describe('[TC-ABS-013-H] settings vault through existing server owners', () => {
  it('exports encrypted settings, previews changed providers, applies and reads model registry back', async () => {
    const call = await start();
    const initial = await call('/model-config');
    const exported = await call('/vault/export', {
      password,
      application,
      domains: ['application', 'providers'],
      bindings: {},
      includeSecrets: [],
    });
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).not.toContain('modelProfiles');
    const decrypted = await decryptVault(exported.body.envelope, password);
    expect(decrypted.domains.providers?.value).not.toHaveProperty('localCredentials');
    expect(decrypted.domains.providers?.value).not.toHaveProperty('secrets');
    expect(
      (
        await call(
          '/model-config',
          {
            revision: initial.body.revision,
            modelProviders: [],
            modelProfiles: [{ id: 'model-a', provider: 'openai', model: 'gpt-test-b' }],
          },
          'PUT',
        )
      ).status,
    ).toBe(200);
    const preview = await call('/vault/preview', {
      password,
      application,
      envelope: exported.body.envelope,
      bindings: {},
    });
    expect(preview.status).toBe(200);
    expect(
      preview.body.entries.find((entry: { domain: string }) => entry.domain === 'providers'),
    ).toMatchObject({ changed: true, available: true });
    expect(JSON.stringify(preview.body)).not.toContain('localCredentials');
    const applied = await call('/vault/apply', {
      password,
      previewId: preview.body.previewId,
      domains: ['providers'],
    });
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe('committed');
    expect((await call('/model-config')).body.modelProfiles).toEqual(initial.body.modelProfiles);
    expect((await call('/vault')).body.status).toBe('committed');
    expect(
      (await call('/model-profiles')).body.map(
        (profile: { profileId: string }) => profile.profileId,
      ),
    ).toEqual(initial.body.modelProfiles.map((profile: { id: string }) => profile.id));
  });
});
describe('[TC-ABS-013-N] closed vault boundaries', () => {
  it('rejects wrong password, unauthorized domain and stale profile state without overwriting', async () => {
    const call = await start();
    const exported = await call('/vault/export', {
      password,
      application,
      domains: ['providers'],
      bindings: {},
      includeSecrets: [],
    });
    expect(
      (
        await call('/vault/preview', {
          password: 'wrong recovery password',
          application,
          envelope: exported.body.envelope,
          bindings: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/vault/export', {
          password,
          application,
          domains: ['runs'],
          bindings: {},
          includeSecrets: [],
        })
      ).status,
    ).toBe(400);
    const preview = await call('/vault/preview', {
      password,
      application,
      envelope: exported.body.envelope,
      bindings: {},
    });
    const current = await call('/model-config');
    await call(
      '/model-config',
      {
        revision: current.body.revision,
        modelProviders: [],
        modelProfiles: [{ id: 'model-a', provider: 'openai', model: 'gpt-test-b' }],
      },
      'PUT',
    );
    const applied = await call('/vault/apply', {
      password,
      previewId: preview.body.previewId,
      domains: ['providers'],
    });
    expect(applied.status).toBe(400);
    expect((await call('/model-config')).body.modelProfiles).toEqual([
      { id: 'model-a', provider: 'openai', model: 'gpt-test-b' },
    ]);
    expect((await call('/vault')).body.status).toBe('rollback_needed');
    expect((await call('/vault/rollback', { password })).body.status).toBe('rolled_back');
  });
});
