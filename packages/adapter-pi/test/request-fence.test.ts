import assert from 'node:assert/strict';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { expect, it, vi } from 'vitest';
import { providerRequestFence } from '../src/request-fence.ts';

const catalogModel = builtinModels().getModel('openai-codex', 'gpt-6.1-sol');
assert(catalogModel);
const model = { ...catalogModel, api: 'openai-codex-responses' as const };
const url = `${model.baseUrl.replace(/\/+$/, '')}/codex/responses`;
const payload = { model: model.id, input: [], reasoning: { effort: 'high' } };
const encoded = (value: unknown) => new Uint8Array(zstdCompressSync(JSON.stringify(value)));
const init = (value = payload): RequestInit => ({
  method: 'POST',
  headers: { 'content-encoding': 'zstd' },
  body: encoded(value),
});

it('permits the installed subscription SDK compressed wire body without changing it', async () => {
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.test`;
  let approved: unknown;
  const fetcher = vi.fn<typeof fetch>(async (_input, request) => {
    expect(new Headers(request?.headers).get('content-encoding')).toBe('zstd');
    expect(request?.body).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(zstdDecompressSync(request?.body as Uint8Array).toString())).toEqual(
      approved,
    );
    return new Response('fixture endpoint reached', { status: 400 });
  });
  const fence = providerRequestFence(model, fetcher);
  assert(fence);
  const result = await codexStream(
    model,
    normalizeContext({ messages: [{ role: 'user', content: 'Fixture', timestamp: 0 }] }),
    {
      apiKey: token,
      reasoning: 'high',
      transport: 'sse',
      maxRetries: 0,
      fetch: fence.fetch,
      onPayload(body) {
        approved = body;
        fence.approve(body);
      },
    },
  ).result();
  expect(result.errorMessage).toContain('fixture endpoint reached');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('accepts a compressed Request body and retains its original bytes and one-send permit', async () => {
  const request = new Request(url, init());
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    expect(input).toBe(request);
    expect(new Uint8Array(await (input as Request).clone().arrayBuffer())).toEqual(
      encoded(payload),
    );
    return new Response('{}');
  });
  const fence = providerRequestFence(model, fetcher);
  assert(fence);
  fence.approve(payload);
  await expect(fence.fetch(request, undefined)).resolves.toHaveProperty('status', 200);
  await expect(fence.fetch(request, undefined)).rejects.toThrow('permit');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects changed decoded payloads, methods, and destinations before dispatch', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const fence = providerRequestFence(model, fetcher);
  assert(fence);
  fence.approve(payload);
  await expect(
    fence.fetch(url, init({ ...payload, reasoning: { effort: 'medium' } })),
  ).rejects.toThrow('payload');
  await expect(fence.fetch(url, { ...init(), method: 'PUT' })).rejects.toThrow('destination');
  await expect(fence.fetch('https://other.invalid/codex/responses', init())).rejects.toThrow(
    'destination',
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects malformed, missing, and unsupported content encodings and body forms', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const requests: RequestInit[] = [
    { ...init(), body: new Uint8Array([1, 2, 3]) },
    { ...init(), headers: {} },
    { ...init(), headers: { 'content-encoding': 'gzip' } },
    { ...init(), headers: { 'content-encoding': 'zstd, gzip' } },
    { ...init(), body: JSON.stringify(payload) },
    { ...init(), body: new Blob([encoded(payload)]) },
    { method: 'POST', headers: { 'content-encoding': 'gzip' }, body: JSON.stringify(payload) },
  ];
  for (const request of requests) {
    const fence = providerRequestFence(model, fetcher);
    assert(fence);
    fence.approve(payload);
    await expect(fence.fetch(url, request)).rejects.toThrow('payload');
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('uses fetch init header/body overrides when checking a Request', async () => {
  const request = new Request(url, init());
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
  const fence = providerRequestFence(model, fetcher);
  assert(fence);
  fence.approve(payload);
  await expect(fence.fetch(request, { headers: {} })).rejects.toThrow('payload');
  await expect(
    fence.fetch(request, { body: encoded({ ...payload, model: 'other' }) }),
  ).rejects.toThrow('payload');
  await expect(
    fence.fetch(request, { headers: {}, body: JSON.stringify(payload) }),
  ).resolves.toHaveProperty('status', 200);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
