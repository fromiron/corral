import { describe, expect, it } from 'vitest';
import { parseModelImport } from '../src/models/imports/parsers.ts';

describe('[TC-ABS-005-H] model configuration import', () => {
  it('reads four sources without evaluating key references or hooks', () => {
    const claude = parseModelImport(
      'claude-code',
      JSON.stringify({
        model: 'claude-sonnet-4',
        env: { ANTHROPIC_API_KEY: 'literal-key' },
        hooks: { command: 'never execute' },
      }),
    );
    expect(claude[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      secret: 'literal-key',
    });
    const codex = parseModelImport(
      'codex',
      'model = "gpt-5"\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"',
    );
    expect(codex[0]).toMatchObject({ provider: 'openai', model: 'gpt-5' });
    const opencode = parseModelImport(
      'opencode',
      JSON.stringify({
        model: 'openai/gpt-5',
        provider: { openai: { options: { apiKey: '{env:OPENAI_API_KEY}' } } },
      }),
    );
    expect(opencode[0]).toMatchObject({ provider: 'openai', model: 'gpt-5' });
    expect(opencode[0]?.secret).toBeUndefined();
    const pi = parseModelImport(
      'pi',
      JSON.stringify({
        providers: {
          local: {
            baseUrl: 'http://localhost:1234/v1',
            api: 'openai-completions',
            apiKey: '!get-secret',
            models: [{ id: 'local-model', reasoning: true, contextWindow: 32000 }],
          },
        },
      }),
    );
    expect(pi[0]).toMatchObject({ model: 'local-model', baseUrl: 'http://localhost:1234/v1' });
    expect(pi[0]?.secret).toBeUndefined();
  });

  it('[TC-ABS-005-N] rejects oversized/malformed files and duplicate model ids', () => {
    expect(() => parseModelImport('pi', 'x'.repeat(1024 * 1024 + 1))).toThrow();
    expect(() => parseModelImport('codex', 'model = "one"\nmodel = "two"')).toThrow();
    expect(() => parseModelImport('pi', '{"providers":')).toThrow();
    expect(() =>
      parseModelImport(
        'pi',
        JSON.stringify({
          providers: { p: { models: [{ id: 'same' }, { id: 'same' }] } },
        }),
      ),
    ).toThrow();
  });

  it('[TC-ABS-005-N] keeps incompatible transport, reference keys, OAuth and reasoning explicit', () => {
    const parsed = parseModelImport(
      'claude-code',
      JSON.stringify({
        model: 'claude-x',
        env: { ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_AUTH_TOKEN: 'oauth-token' },
      }),
    );
    expect(parsed[0]?.unsupported).toContain(
      'Custom Anthropic endpoints are not supported by this importer.',
    );
    expect(parsed[0]?.secret).toBeUndefined();
    const pi = parseModelImport(
      'pi',
      JSON.stringify({
        providers: { openai: { apiKey: 'env:KEY', models: [{ id: 'm' }] } },
      }),
    );
    expect(pi[0]?.warnings).toContain(
      'Credential references are not evaluated. Configure authentication in Corral.',
    );
  });
});
