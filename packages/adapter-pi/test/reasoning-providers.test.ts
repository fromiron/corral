import type { EffectiveHarnessSnapshot, ReasoningResolution } from '@corral/contracts';
import { Coordinator, InProcessTransport, waitForProjection } from '@corral/core';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { startCompatibleEndpoint } from '@corral/testkit/endpoint';
import { getSupportedThinkingLevels, type Model, normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple as completions } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as responses } from '@earendil-works/pi-ai/api/openai-responses';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { SDK_WORKER_ENTRY, WORKER_ENTRY } from '../src/index.ts';
import { modelBridgeChannel } from '../src/model-bridge.ts';
import {
  modelReasoningCapabilities,
  reasoningRequest,
  verifyReasoningWire,
} from '../src/reasoning.ts';
import { providerRequestFence } from '../src/request-fence.ts';
import { sandboxChannel } from '../src/sandbox-channel.ts';

it('accepts Pi ChatGPT OAuth cap omission only for the pinned official transport, while API keys retain their cap', async () => {
  const model = builtinModels().getModel('openai', 'gpt-6.1-sol')!;
  const resolution: ReasoningResolution = {
    requested: { mode: 'fixed', level: 'high' },
    resolved: 'high',
    source: 'fixed',
    preparationId: 'oauth_fixture',
  };
  for (const auth of ['oauth', 'api_key'] as const) {
    const request = reasoningRequest(model, { maxTokens: 4096 }, resolution);
    let captured: unknown;
    const result = await responses(
      request.model as Model<'openai-responses'>,
      normalizeContext({ messages: [{ role: 'user', content: 'Fixture', timestamp: 0 }] }),
      {
        ...request.options,
        apiKey: auth === 'oauth' ? 'fixture-chatgpt-token' : 'sk-fixture',
        fetch: async () => {
          throw new Error('network forbidden');
        },
        onPayload: (payload) => {
          captured = payload;
          throw new Error('captured before send');
        },
      },
    ).result();
    expect(result.errorMessage).toContain('captured before send');
    expect((captured as { max_output_tokens?: number }).max_output_tokens).toBe(
      auth === 'oauth' ? undefined : 4096,
    );
    expect(verifyReasoningWire(model, captured, resolution, 4096, auth)).toEqual({
      kind: 'effort',
      value: 'high',
    });
    if (auth === 'oauth') {
      expect(() => verifyReasoningWire(model, captured, resolution, 4096, 'api_key')).toThrow(
        'output',
      );
      expect(() =>
        verifyReasoningWire(
          { ...model, baseUrl: 'https://gateway.example/v1' },
          captured,
          resolution,
          4096,
          'oauth',
        ),
      ).toThrow('output');
    }
  }
});

it('resolves OpenAI and DeepSeek maximum from actual Pi payloads and rejects changed effort or output caps', async () => {
  const catalog = builtinModels();
  for (const [provider, id] of [
    ['openai', 'gpt-6.1-sol'],
    ['deepseek', 'deepseek-v4-pro'],
  ] as const) {
    const model = catalog.getModel(provider, id)!;
    const level = getSupportedThinkingLevels(model).at(-1)!;
    expect(modelReasoningCapabilities(model).levels).toContain(level);
    const resolution: ReasoningResolution = {
      requested: { mode: 'fixed', level },
      resolved: level,
      source: 'fixed',
      preparationId: 'fixture',
    };
    const request = reasoningRequest(model, { maxTokens: 4096 }, resolution);
    let payload: Record<string, unknown> | undefined;
    let network = 0;
    const options = {
      ...request.options,
      apiKey: 'sk-fixture',
      fetch: async () => {
        network++;
        throw new Error('network forbidden');
      },
      onPayload: (value: unknown) => {
        payload = value as Record<string, unknown>;
        throw new Error('captured before send');
      },
    };
    const context = normalizeContext({
      messages: [{ role: 'user', content: 'Fixture only', timestamp: 0 }],
    });
    const result = await (model.api === 'openai-responses'
      ? responses(request.model as Model<'openai-responses'>, context, options)
      : completions(request.model as Model<'openai-completions'>, context, options)
    ).result();
    expect(result.errorMessage).toContain('captured before send');
    expect(network).toBe(0);
    expect(verifyReasoningWire(model, payload, resolution, 4096)).toMatchObject({
      kind: 'effort',
      value: level,
    });
    const capped = structuredClone(payload!);
    capped[model.api === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'] = 4097;
    expect(() => verifyReasoningWire(model, capped, resolution, 4096)).toThrow('output');
    const wrongCap = structuredClone(payload!);
    delete wrongCap[model.api === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'];
    wrongCap.max_completion_tokens = 4096;
    expect(() => verifyReasoningWire(model, wrongCap, resolution, 4096)).toThrow('output');
    const changed = structuredClone(payload!);
    if (model.api === 'openai-responses') {
      const updates = changed.input as { type: string; reasoning?: { effort: string } }[];
      updates.findLast((item) => item.type === 'configuration_update')!.reasoning!.effort = 'low';
    } else {
      changed.reasoning_effort = 'high';
      changed.reasoning = { effort: 'max' };
    }
    expect(() => verifyReasoningWire(model, changed, resolution, 4096)).toThrow('differs');
  }
});

it
  .skipIf(process.env.CORRAL_SANDBOX_PROBE !== '1' || process.platform !== 'linux')
  .each([false, true])(
  'DeepSeek maximum traverses the actual isolated Pi worker (SDK=%s), host permit and local HTTP tool round trip',
  async (sdk) => {
    const endpoint = await startCompatibleEndpoint();
    const source = builtinModels().getModel('deepseek', 'deepseek-v4-pro')!;
    const model = { ...source, baseUrl: endpoint.baseUrl, api: 'openai-completions' as const };
    let requests = 0;
    endpoint.setReply((body) => {
      expect(body).toMatchObject({
        model: source.id,
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
        max_tokens: 4096,
      });
      const artifact = [...JSON.stringify(body).matchAll(/artv_[A-Za-z0-9]+/g)].at(-1)?.[0];
      return ++requests === 1
        ? { toolCall: { name: 'write_artifact', args: { text: 'DeepSeek fixture result' } } }
        : { toolCall: { name: 'submit_result', args: { artifactVersionIds: [artifact] } } };
    });
    const harness: EffectiveHarnessSnapshot = {
      binding: { profileId: 'empty', revision: 1 },
      snapshotHash: 'a'.repeat(64),
      piVersion: '1.3.0',
      policyRevision: 1,
      policy: 'strict',
      resources: [],
      allowedTools: ['write_artifact', 'submit_result'],
      tools: [],
      diagnostics: [],
    };
    const spawn = (entry: string) =>
      modelBridgeChannel(sandboxChannel(entry), {
        model,
        streamFn: (_selected, context, options) => completions(model, context, options),
      });
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      ...(sdk ? { harnesses: { resolve: () => harness } } : {}),
      models: {
        resolve: (profile) => ({
          ok: true,
          snapshot: {
            profile,
            provider: source.provider,
            modelId: source.id,
            auth: 'api_key',
            workerIsolation: 'linux-bwrap',
            reasoning: modelReasoningCapabilities(source),
          },
        }),
      },
      agents: new PiAgentAdapter({
        spawn: () => spawn(WORKER_ENTRY),
        spawnSdk: () => spawn(SDK_WORKER_ENTRY),
        credentials: async () => 'fixture-deepseek-key',
        harness: async () => ({ extensions: [], skills: [], startupCommands: [], bundles: [] }),
      }),
    });
    try {
      const definition = linearCorral(['writer']);
      definition.roles[0]!.reasoning = { mode: 'fixed', level: 'max' };
      if (sdk) definition.roles[0]!.harness = harness.binding;
      const started = coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'deepseek_fixture',
        definition,
        mode: 'live',
      });
      expect(started.receipt.error).toBeUndefined();
      const transport = new InProcessTransport(coordinator);
      const final = await waitForProjection(transport, started.runId!, (p) =>
        ['succeeded', 'failed', 'cancelled'].includes(p.status),
      );
      expect(final.status).toBe('succeeded');
      expect(endpoint.models).toEqual([source.id, source.id]);
      expect(endpoint.authorizations).toEqual([
        'Bearer fixture-deepseek-key',
        'Bearer fixture-deepseek-key',
      ]);
      expect(final.budget.modelCalls).toBe(2);
      expect(final.budget.spent).toBe(4);
      expect(final.budget.unknownOutstanding).toBe(0);
      expect(
        await transport.getArtifactText(started.runId!, final.output!.artifactVersionIds[0]!),
      ).toBe('DeepSeek fixture result');
    } finally {
      await endpoint.close();
    }
  },
  30_000,
);

it('one permit sends one approved inference request even when transport retries or changes its destination/body', async () => {
  const model = {
    ...builtinModels().getModel('deepseek', 'deepseek-v4-pro')!,
    baseUrl: 'http://127.0.0.1:1',
  };
  const sent: { url: string; body: unknown; redirect: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    sent.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      redirect: init?.redirect,
    });
    return new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } });
  };
  const payload = { model: model.id, messages: [], max_tokens: 4096 };
  const init = { method: 'POST', body: JSON.stringify(payload) };
  const url = `${model.baseUrl}/chat/completions`;
  const fence = providerRequestFence(model, fetcher)!;
  await expect(fence.fetch(url, init)).rejects.toThrow('permit');
  fence.approve(payload);
  await expect(fence.fetch('http://127.0.0.1:2/chat/completions', init)).rejects.toThrow(
    'destination',
  );
  await expect(
    fence.fetch(url, { ...init, body: JSON.stringify({ ...payload, model: 'other' }) }),
  ).rejects.toThrow('payload');
  await expect(fence.fetch(url, init)).resolves.toHaveProperty('status', 429);
  await expect(fence.fetch(url, init)).rejects.toThrow('permit');
  expect(sent).toEqual([{ url, body: payload, redirect: 'error' }]);
  const aborted = new AbortController();
  const stopped = providerRequestFence(model, fetcher, aborted.signal)!;
  stopped.approve(payload);
  aborted.abort();
  await expect(stopped.fetch(url, init)).rejects.toThrow('cancelled');
  expect(sent).toHaveLength(1);
});
