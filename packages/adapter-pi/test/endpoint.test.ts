import { startCompatibleEndpoint } from '@corral/testkit/endpoint';
import { createModels } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { type EndpointSpec, endpointProvider, KEYLESS_PLACEHOLDER } from '../src/endpoint.ts';

// CR-005: OpenAI-compatible endpoints (Ollama, LM Studio, OpenRouter) through pi-ai's
// openai-completions client, against a local fake server.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function endpoint() {
  const server = await startCompatibleEndpoint();
  closers.push(server.close);
  return server;
}

const spec = (baseUrl: string, keyless: boolean): EndpointSpec => ({
  name: 'Local',
  baseUrl,
  keyless,
  models: [{ id: 'llama3.2', contextWindow: 8000, maxOutput: 512, reasoning: false }],
});

const ask = (models: ReturnType<typeof createModels>, apiKey?: string) => {
  const model = models.getModel('local', 'llama3.2');
  if (!model) throw new Error('no model');
  return models
    .streamSimple(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      apiKey ? { apiKey } : {},
    )
    .result();
};

describe('OpenAI-compatible endpoints (CR-005)', () => {
  it('[TC-SEC-002-H] a keyless local endpoint answers with only the placeholder key; a keyed one gets the request key', async () => {
    const server = await endpoint();
    server.setReply(() => 'Hello from the endpoint.');
    const keyless = createModels();
    keyless.setProvider(endpointProvider('local', spec(server.baseUrl, true)));
    const answer = await ask(keyless);
    expect(answer.errorMessage ?? '').toBe('');
    expect(answer.stopReason).toBe('stop');
    expect(JSON.stringify(answer.content)).toContain('Hello from the endpoint.');
    expect(answer.usage.output).toBe(2);
    expect(server.models).toEqual(['llama3.2']);
    expect(server.authorizations).toEqual([`Bearer ${KEYLESS_PLACEHOLDER}`]);

    const keyed = createModels();
    keyed.setProvider(endpointProvider('local', spec(server.baseUrl, false)));
    await ask(keyed, 'request-key');
    expect(server.authorizations.at(-1)).toBe('Bearer request-key');
  });

  it('[TC-SEC-002-N] a keyed endpoint without a key is not configured and sends nothing', async () => {
    const server = await endpoint();
    const keyed = createModels();
    keyed.setProvider(endpointProvider('local', spec(server.baseUrl, false)));
    const answer = await ask(keyed);
    expect(answer.stopReason).toBe('error');
    expect(answer.errorMessage).toMatch(/not configured/);
    expect(server.authorizations).toEqual([]);
  });
});
