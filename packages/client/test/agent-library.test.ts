import type { LibraryAgent } from '@corral/contracts';
import { describe, expect, it, vi } from 'vitest';
import { RestAgentLibrary } from '../src/index.ts';

const change = { expectedRevision: 1, archived: true };
const agent: LibraryAgent = {
  projectId: 'project:one',
  agentId: 'agent:one',
  revision: 1,
  role: {
    name: 'Reviewer',
    prompt: 'Review the changes.',
    modelProfile: 'model-a',
    allowedWorkTools: [],
    allowedCollaborationTools: [],
    outputContract: 'review',
  },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  archivedAt: null,
};
const archived = {
  ...agent,
  archivedAt: '2026-01-02T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};
const collection = '/api/v1/projects/project%3Aone/agents';
const item = `${collection}/agent%3Aone`;

describe('RestAgentLibrary', () => {
  it('posts the create input and patches the item, wrapping raw agent responses', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: 'csrf' }))
      .mockResolvedValueOnce(Response.json(agent, { status: 201 }))
      .mockResolvedValueOnce(Response.json(archived));
    const library = new RestAgentLibrary({ baseUrl: '', fetch });
    const input = { role: agent.role, operationId: 'create_reviewer' };

    expect(await library.create(agent.projectId, input)).toEqual({ ok: true, agent });
    expect(await library.update(agent.projectId, agent.agentId, change)).toEqual({
      ok: true,
      agent: archived,
    });
    const requests = fetch.mock.calls.map(([url, init]) => [
      url,
      init?.method ?? 'GET',
      init?.body ? JSON.parse(String(init.body)) : undefined,
      new Headers(init?.headers).get('x-corral-csrf'),
    ]);
    expect(requests).toEqual([
      ['/api/v1/session', 'GET', undefined, null],
      [collection, 'POST', input, 'csrf'],
      [item, 'PATCH', change, 'csrf'],
    ]);
  });

  it('gets a project list and item; only a missing item becomes null', async () => {
    const missing = Response.json(
      { error: { code: 'TARGET_NOT_FOUND', message: 'untrusted detail' } },
      { status: 404 },
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json([archived]))
      .mockResolvedValueOnce(Response.json(archived))
      .mockResolvedValueOnce(missing.clone())
      .mockResolvedValueOnce(missing);
    const library = new RestAgentLibrary({ baseUrl: '', fetch });

    expect(await library.list(agent.projectId)).toEqual([archived]);
    expect(await library.get(agent.projectId, agent.agentId)).toEqual(archived);
    expect(await library.get('other', agent.agentId)).toBeNull();
    await expect(library.list('other')).rejects.toThrow(
      new Error('Could not read the agent library.'),
    );
    const requests = fetch.mock.calls.map(([url, init]) => [
      url,
      init?.method ?? 'GET',
      init?.body,
    ]);
    expect(requests).toEqual([
      [collection, 'GET', undefined],
      [item, 'GET', undefined],
      ['/api/v1/projects/other/agents/agent%3Aone', 'GET', undefined],
      ['/api/v1/projects/other/agents', 'GET', undefined],
    ]);
  });

  it.each([
    [400, 'SCHEMA_INVALID', 'invalid'],
    [404, 'TARGET_NOT_FOUND', 'not_found'],
    [409, 'REVISION_CONFLICT', 'revision_conflict'],
    [409, 'IDEMPOTENCY_CONFLICT', 'operation_conflict'],
    [503, 'STORAGE_UNAVAILABLE', 'storage_unavailable'],
    [409, 'UNKNOWN', 'storage_unavailable'],
  ] as const)('maps %d %s without losing the conflict kind', async (status, code, error) => {
    const library = new RestAgentLibrary({
      baseUrl: '',
      fetch: async (url, init) => {
        if (String(url).endsWith('/session')) return Response.json({ csrfToken: 'csrf' });
        expect(String(url)).toBe('/api/v1/projects/default/agents/agent_a');
        expect(init?.method).toBe('PATCH');
        expect(JSON.parse(String(init?.body))).toEqual(change);
        return Response.json({ error: { code, message: 'Refused' } }, { status });
      },
    });
    const result = await library.update('default', 'agent_a', change);
    expect(result).toMatchObject({ ok: false, error });
    if (!result.ok) expect(result.message).not.toContain('Refused');
  });

  it('reports unavailable writes and rejects unavailable reads, not an empty library', async () => {
    const library = new RestAgentLibrary({
      baseUrl: '',
      fetch: async () => {
        throw new TypeError('network unavailable');
      },
    });
    const result = await library.update('default', 'agent_a', change);
    expect(result).toMatchObject({ ok: false, error: 'storage_unavailable' });
    if (!result.ok) expect(result.message).not.toContain('network unavailable');
    await expect(library.list('default')).rejects.toThrow(
      new Error('Could not read the agent library.'),
    );
    await expect(library.get('default', 'agent_a')).rejects.toThrow(
      new Error('Could not read the library agent.'),
    );
  });
});
