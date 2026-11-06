import { expect, it } from 'vitest';
import { WorkspacesApi } from '../src/index.ts';

it('keeps a branch refusal reason from its command receipt instead of HTTP Conflict', async () => {
  const api = new WorkspacesApi({
    baseUrl: 'http://fixture.invalid',
    fetch: async (url) =>
      String(url).endsWith('/session')
        ? Response.json({ csrfToken: 'test' })
        : Response.json(
            {
              runId: null,
              receipt: { error: { code: 'RUN_ALREADY_ACTIVE', message: 'another run is active' } },
            },
            { status: 409, statusText: 'Conflict' },
          ),
  });
  await expect(
    api.branchMessage({
      sourceRunId: 'source',
      requestStart: true,
      expectedHash: 'a'.repeat(64),
      commandId: 'branch',
    }),
  ).rejects.toMatchObject({
    status: 409,
    code: 'RUN_ALREADY_ACTIVE',
    message: 'another run is active',
  });
});
