import { startCompatibleEndpoint } from '@corral/testkit/endpoint';
import { createModels } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectContext, reconcileContextUsage } from '../src/context-usage.ts';
import { type EndpointSpec, endpointProvider, KEYLESS_PLACEHOLDER } from '../src/endpoint.ts';
import { providerFailure } from '../src/ported/dsh/retry.ts';

// OpenAI-compatible endpoints (Ollama, LM Studio, OpenRouter) through pi-ai's
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

describe('OpenAI-compatible endpoints', () => {
  it('classifies a stopped local endpoint through the real Pi client as a transport failure', async () => {
    const server = await endpoint();
    const models = createModels();
    models.setProvider(endpointProvider('local', spec(server.baseUrl, true)));
    await server.close();

    const answer = await ask(models);
    expect(answer.stopReason).toBe('error');
    expect(providerFailure(answer.errorMessage)).toEqual({
      code: 'TRANSPORT',
      status: null,
      retryAfterMs: null,
      requestId: null,
    });
  });

  it('classifies native fetch connection failures without retaining their diagnostics', async () => {
    const server = await endpoint();
    await server.close();
    const failure = await fetch(`${server.baseUrl}/models`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(providerFailure(failure)).toEqual({
      code: 'TRANSPORT',
      status: null,
      retryAfterMs: null,
      requestId: null,
    });
  });

  it('measures the real Pi provider payload without adding provider usage', async () => {
    const server = await endpoint();
    server.setReply(() => 'Measured.');
    const models = createModels();
    models.setProvider(endpointProvider('local', spec(server.baseUrl, true)));
    const model = models.getModel('local', 'llama3.2');
    if (!model) throw new Error('no model');
    const context = {
      messages: [
        { role: 'system' as const, content: 'Use the provided sources.', timestamp: 0 },
        { role: 'user' as const, content: '한국어와日本語 자료를 찾아줘.', timestamp: 1 },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Find supplied documents.',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    };
    const inspected = inspectContext(context, { mcpToolNames: ['lookup'] });
    let recorded: ReturnType<typeof reconcileContextUsage> | undefined;
    const result = await models
      .streamSimple(model, context, {
        onPayload: (payload) => {
          recorded = reconcileContextUsage(
            inspected.usage,
            inspected.probes,
            JSON.stringify(payload),
          );
        },
      })
      .result();
    expect(result.stopReason).toBe('stop');
    expect(recorded).toMatchObject({ coverage: 'request', completeness: 'complete' });
    expect(recorded?.parts.find((part) => part.category === 'mcp_tools')?.tokens).toBeGreaterThan(
      0,
    );
    expect(recorded?.usedTokens).toBe(recorded?.parts.reduce((sum, part) => sum + part.tokens, 0));
    expect(JSON.stringify(recorded)).not.toContain('한국어');
  });

  it('a keyless local endpoint answers with only the placeholder key; a keyed one gets the request key', async () => {
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

  it('a keyed endpoint without a key is not configured and sends nothing', async () => {
    const server = await endpoint();
    const keyed = createModels();
    keyed.setProvider(endpointProvider('local', spec(server.baseUrl, false)));
    const answer = await ask(keyed);
    expect(answer.stopReason).toBe('error');
    expect(answer.errorMessage).toMatch(/not configured/);
    expect(server.authorizations).toEqual([]);
  });
});
