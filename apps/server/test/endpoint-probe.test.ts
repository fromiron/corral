import { expect, it, vi } from 'vitest';
import { probeEndpoint } from '../src/models/endpoint-probe.ts';

it('checks the configured models path without inference or redirects', async () => {
  const send = vi.fn(async () => new Response('{}', { status: 200 }));
  const result = await probeEndpoint({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'secret',
    fetch: send,
  });
  expect(result).toEqual({ kind: 'connected', status: 200 });
  expect(send).toHaveBeenCalledWith(
    'http://127.0.0.1:1234/v1/models',
    expect.objectContaining({
      method: 'GET',
      redirect: 'manual',
      headers: { authorization: 'Bearer secret' },
    }),
  );
});
it.each([
  [401, 'authentication'],
  [429, 'rateLimit'],
  [503, 'server'],
  [302, 'redirect'],
  [404, 'unsupported'],
] as const)('classifies HTTP %s without returning its body', async (status, kind) => {
  const result = await probeEndpoint({
    baseUrl: 'http://127.0.0.1:1234/v1',
    fetch: async () => new Response('secret response', { status }),
  });
  expect(result).toEqual({ kind, status });
});
it('does not expose network details', async () => {
  expect(
    await probeEndpoint({
      baseUrl: 'http://127.0.0.1:1234',
      fetch: async () => {
        throw new Error('private path and token');
      },
    }),
  ).toEqual({ kind: 'connection', status: null });
});
