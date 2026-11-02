// No credentials, server, model invocation, or network. Tests the installed transport shape.
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { providerRequestFence } from '../../../../packages/adapter-pi/src/request-fence.ts';

let dispatched = 0;
const model = {
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  id: 'gpt-6.1-sol',
};
const body = JSON.stringify({ model: model.id, input: [], reasoning: { effort: 'high' } });
const fence = providerRequestFence(model, async () => {
  dispatched++;
  return new Response('{}');
});
assert(fence);
fence.approve(JSON.parse(body));
let error: string | null = null;
try {
  await fence.fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: { 'content-encoding': 'zstd' },
    body: new Uint8Array(zstdCompressSync(body)),
  });
} catch (failure) {
  error = failure instanceof Error ? failure.message : 'unknown';
}
console.log(
  JSON.stringify({ error, dispatched, compressedBodyType: 'Uint8Array', node: process.version }),
);
