import { expect, it } from 'vitest';
import { WorkspacesApi } from '../src/index.ts';

// docs/specs/features/inbox.md `advice`: opening the execution row the advice was for.

it('tells the server an execution row was opened, behind the CSRF boundary', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const api = new WorkspacesApi({
    baseUrl: '',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/session')) return Response.json({ csrfToken: 'csrf' });
      return new Response(null, { status: 204 });
    },
  });
  await expect(api.executionOpened('run 1', 'exec/1')).resolves.toBeUndefined();
  expect(calls.map((call) => call.url)).toEqual([
    '/api/v1/session',
    '/api/v1/runs/run%201/executions/exec%2F1/opened',
  ]);
  expect(calls[1]?.init?.method).toBe('POST');
  expect(new Headers(calls[1]?.init?.headers).get('x-corral-csrf')).toBe('csrf');
});

it('rejects when the server refuses, so the caller keeps the item', async () => {
  const api = new WorkspacesApi({
    baseUrl: '',
    fetch: async (url) =>
      String(url).endsWith('/session')
        ? Response.json({ csrfToken: 'csrf' })
        : Response.json(
            { error: { code: 'TARGET_NOT_FOUND', message: 'no such execution' } },
            { status: 404 },
          ),
  });
  await expect(api.executionOpened('run_1', 'exec_1')).rejects.toMatchObject({
    code: 'TARGET_NOT_FOUND',
  });
});
