import { expect, it, vi } from 'vitest';
import { WorkspacesApi } from '../src/index.ts';

it('discovers the requested scope and preserves raw paths and exact diff preconditions in authenticated GETs', async () => {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const response = { observed: true };
  const api = new WorkspacesApi({
    baseUrl: 'http://fixture.invalid',
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return Response.json(response);
    },
  });
  const scopes = [
    { kind: 'project' as const, id: 'project_1' },
    { kind: 'session' as const, id: 'session_1' },
  ];
  const project = {
    kind: 'project' as const,
    hostId: 'host',
    projectId: 'project_1',
    bindingId: 'binding',
  };
  const session = {
    ...project,
    kind: 'session' as const,
    sessionId: 'session_1',
    copyGeneration: 2,
  };
  for (const [index, scope] of scopes.entries()) {
    expect(await api.gitStatus(scope)).toEqual(response);
    const request = {
      target: index === 0 ? project : session,
      side: 'unstaged' as const,
      path: ' 한글 dir/line\nname &?#%.ts ',
      head: index === 0 ? null : 'a'.repeat(40),
      indexHash: 'b'.repeat(64),
    };
    expect(await api.gitDiff(scope, request)).toEqual(response);
    const prefix =
      index === 0 ? '/api/v1/projects/project_1/workspace' : '/api/v1/sessions/session_1/worktree';
    const status = calls[index * 2];
    const diff = calls[index * 2 + 1];
    expect(status?.url.pathname).toBe(`${prefix}/git/status`);
    expect(status?.url.search).toBe('');
    expect(diff?.url.pathname).toBe(`${prefix}/git/diff`);
    expect(diff?.url.searchParams.get('path')).toBe(request.path);
    expect(JSON.parse(diff?.url.searchParams.get('target') ?? 'null')).toEqual(request.target);
    expect(diff?.url.searchParams.get('side')).toBe(request.side);
    expect(diff?.url.searchParams.get('head')).toBe(request.head ?? '');
    expect(diff?.url.searchParams.get('indexHash')).toBe(request.indexHash);
  }
  expect(
    calls.every(
      (call) =>
        call.init?.method === 'GET' &&
        call.init.body === undefined &&
        call.init.credentials === 'same-origin',
    ),
  ).toBe(true);
  expect(calls).toHaveLength(4);
});

it('preserves a stale-index refusal without replaying the read against another revision', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json(
        { error: { code: 'REVISION_CONFLICT', message: 'index changed' } },
        { status: 409 },
      ),
    );
  const api = new WorkspacesApi({ baseUrl: 'http://fixture.invalid', fetch: fetcher });
  await expect(
    api.gitDiff(
      { kind: 'project', id: 'project' },
      {
        target: { kind: 'project', hostId: 'host', projectId: 'project', bindingId: 'binding' },
        side: 'staged',
        path: 'file.ts',
        head: null,
        indexHash: 'a'.repeat(64),
      },
    ),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT', message: 'index changed' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
