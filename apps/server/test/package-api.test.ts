import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { expect, it } from 'vitest';
import { startCorralServer } from '../src/app.ts';

it('reviews package declarations, registers MCP disabled and preserves provenance on edits and removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-package-api-'));
  const source = join(root, 'package');
  const repository = join(root, 'repository');
  mkdirSync(source);
  execFileSync('git', ['init', '-q', repository]);
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'package-fixture',
      version: '1.0.0',
      license: 'MIT',
      pi: { skills: [], extensions: [] },
      corral: {
        version: 1,
        requestedCapabilities: ['read_document'],
        mcpServers: [
          {
            id: 'docs',
            name: 'Package docs',
            transport: 'http',
            url: 'https://example.invalid/mcp',
          },
        ],
        ui: [
          {
            id: 'guide',
            slot: 'package-details',
            title: 'Guide',
            body: '<script>plain text</script>',
          },
        ],
      },
    }),
  );
  const token = 'package-api-bootstrap-0123456789';
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  try {
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
      const response = await fetch(`${server.url}/api/v1${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      return result;
    };
    await call('/projects/default/workspace', { path: repository }, 'PUT');
    await call('/projects/default/workspace', { trusted: true }, 'PATCH');
    const review = await call('/harness/packages/review', { kind: 'local', source });
    expect(review.manifest.requestedCapabilities).toEqual(['read_document']);
    const resource = await call('/harness/resources', { reviewId: review.reviewId });
    expect(resource.trustedAt).toBeNull();
    const registration = {
      contributionId: 'docs',
      projectId: 'default',
      expectedRevision: 0,
      operationId: 'register_package_docs',
    };
    const config = await call(`/harness/packages/${resource.hash}/mcp`, registration);
    expect(config.mcpServers).toEqual([
      expect.objectContaining({ enabled: false, sourcePackageHash: resource.hash }),
    ]);
    expect(await call(`/harness/packages/${resource.hash}/mcp`, registration)).toEqual(config);
    const registered = config.mcpServers[0];
    await call(`/harness/resources/${resource.hash}/trust`, { trusted: true }, 'PUT');
    const { id: _id, sourcePackageHash: _source, ...draft } = registered;
    const updated = await call('/harness/projects/default/mcp', {
      expectedRevision: config.revision,
      operationId: 'enable_package_docs',
      serverId: registered.id,
      draft: { ...draft, enabled: true },
    });
    expect(updated.mcpServers[0].sourcePackageHash).toBe(resource.hash);
    const profile = await call(
      '/harness/profiles/package-test',
      {
        expectedRevision: 0,
        profile: {
          name: 'Package test',
          policy: 'trusted-native',
          allowedTools: [],
          resources: [],
          startupCommands: [],
          mcpServerIds: [registered.id],
        },
      },
      'PUT',
    );
    const preview = () =>
      call('/harness/preview', {
        binding: { profileId: profile.profileId, revision: profile.revision },
        projectId: 'default',
      });
    expect((await preview()).snapshot.projectTools.mcpServerIds).toEqual([registered.id]);
    await call(
      `/harness/packages/${resource.hash}`,
      { expectedRevision: 0, status: 'removed', operationId: 'remove_package' },
      'PUT',
    );
    expect((await preview()).snapshot.projectTools.mcpServerIds ?? []).toEqual([]);
    expect((await call('/harness/packages'))[0]).toMatchObject({
      status: 'removed',
      resource: { hash: resource.hash },
    });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
