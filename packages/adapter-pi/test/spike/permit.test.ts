import { fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_ID, PROVIDER, spikeSession } from './sdk-session.ts';

// S1 (CR-018, plan §6 H1): every model request of a Pi SDK session gets a host permit first.

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe('S1: one permit per model request', () => {
  it('[TC-HAR-001-H] a prompt, an automatic retry and a compaction each ask for a permit', async () => {
    const run = await spikeSession({
      responses: [
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'The service is temporarily unavailable',
        }),
        fauxAssistantMessage('Hello.'),
        fauxAssistantMessage('Hello again.'),
        fauxAssistantMessage('Summary of the conversation.'),
        // With almost nothing kept, compaction also summarizes the split turn's prefix.
        fauxAssistantMessage('Summary of the turn prefix.'),
      ],
      settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 } },
    });
    dispose = run.dispose;
    await run.session.prompt('Say hello.');
    expect(run.session.getLastAssistantText()).toBe('Hello.');
    await run.session.prompt('Say hello again.');
    await run.session.compact();
    // error + retry, second prompt, two summarization calls
    expect(run.log.permits).toHaveLength(5);
    expect(run.log.dispatches).toEqual(run.log.permits);
    expect(run.faux.getPendingResponseCount()).toBe(0);
  });

  it('[TC-HAR-001-H] a model call an extension tool makes through ctx.modelRegistry asks too', async () => {
    const run = await spikeSession({
      responses: [
        fauxAssistantMessage([fauxToolCall('ask_model', { question: 'two plus two' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Four.'),
        fauxAssistantMessage('It is four.'),
      ],
      extensions: [
        (pi) => {
          pi.registerTool({
            name: 'ask_model',
            label: 'ask_model',
            description: 'Ask another model.',
            parameters: Type.Object({ question: Type.String() }),
            execute: async (_id, params, _signal, _update, ctx) => {
              const model = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
              if (!model) throw new Error('no model');
              const answer = await ctx.modelRegistry
                .streamSimple(model, {
                  messages: [{ role: 'user', content: params.question, timestamp: 0 }],
                })
                .result();
              const text = answer.content.flatMap((c) => (c.type === 'text' ? [c.text] : []));
              return { content: [{ type: 'text', text: text.join('') }], details: undefined };
            },
          });
        },
      ],
    });
    dispose = run.dispose;
    await run.session.prompt('Use ask_model.');
    expect(run.session.getLastAssistantText()).toBe('It is four.');
    expect(run.log.permits).toHaveLength(3);
    expect(run.log.dispatches).toEqual(run.log.permits);
  });

  it('[TC-HAR-001-N] a refused permit ends the run without reaching the model', async () => {
    const run = await spikeSession({
      responses: [fauxAssistantMessage('Should not be sent.')],
      permit: () => false,
      settings: { retry: { enabled: false } },
    });
    dispose = run.dispose;
    await run.session.prompt('Say hello.');
    expect(run.log.refused).toBeGreaterThan(0);
    expect(run.log.dispatches).toEqual([]);
    expect(run.faux.getPendingResponseCount()).toBe(1);
  });

  it('[TC-HAR-001-N] an extension cannot reach another provider: the runtime has no credentials', async () => {
    const attempts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      attempts.push(String(input));
      throw new Error('network is off in this test');
    }) as typeof fetch;
    try {
      let outcome = '';
      let keys: string | undefined;
      const run = await spikeSession({
        responses: [
          fauxAssistantMessage([fauxToolCall('side_call', {})], { stopReason: 'toolUse' }),
          fauxAssistantMessage('Done.'),
        ],
        extensions: [
          (pi) => {
            pi.registerTool({
              name: 'side_call',
              label: 'side_call',
              description: 'Call a model directly.',
              parameters: Type.Object({}),
              execute: async (_id, _params, _signal, _update, ctx) => {
                const other = ctx.modelRegistry.getAll().find((m) => m.provider === 'openai');
                if (!other) {
                  outcome = 'no openai models';
                } else {
                  try {
                    const answer = await ctx.modelRegistry
                      .streamSimple(other, {
                        messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
                      })
                      .result();
                    outcome = `${answer.stopReason}: ${answer.errorMessage ?? ''}`;
                  } catch (error) {
                    outcome = `error: ${String(error)}`;
                  }
                  keys = await ctx.modelRegistry.getApiKeyForProvider('openai');
                }
                return { content: [{ type: 'text', text: outcome }], details: undefined };
              },
            });
          },
        ],
      });
      dispose = run.dispose;
      await run.session.prompt('Use side_call.');
      expect(outcome).toMatch(/no openai models|error/);
      expect(attempts).toEqual([]);
      expect(keys).toBeUndefined();
      expect(run.log.permits).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('[TC-HAR-003-H] the Corral provider sees the final request, with sections extensions added', async () => {
    const run = await spikeSession({
      responses: [fauxAssistantMessage('Hello.')],
      extensions: [
        (pi) => {
          pi.on('before_agent_start', async (event) => {
            const sections = event.systemPromptOptions?.sections as
              | Record<string, string>
              | undefined;
            if (sections) sections.style = 'Answer in one short sentence.';
          });
        },
      ],
    });
    dispose = run.dispose;
    await run.session.prompt('Say hello.');
    expect(run.log.requests).toHaveLength(1);
    expect(run.log.requests[0]?.systemPrompt).toContain('Answer in one short sentence.');
    // Faux builds no HTTP payload, so before_provider_request does not fire here (see report).
    expect(run.log.payloads).toEqual([]);
  });
});
