// Fixtures adapted from PI-Desktop 1a812ed fixed-tool-declarations.test.ts and session-affinity.test.ts (LGPL-3.0-only).
import { type Model, normalizeContext, Type } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import {
  toolDeclarationPolicy,
  withFixedToolDeclarations,
  withSessionAffinityOptions,
} from '../src/index.ts';

const model: Model<'openai-completions'> = {
  id: 'deepseek-flash',
  name: 'Fixture',
  api: 'openai-completions',
  provider: 'fixture',
  baseUrl: 'https://api.deepseek.com',
  input: ['text'],
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsMidConvoSystemMessages: true },
};
const tool = (name: string) => ({ name, description: 'Fixture tool', parameters: Type.Object({}) });
it('preserves upstream declaration ordering, identity and route-scoped limits', () => {
  const first = toolDeclarationPolicy(model, [tool('Alpha'), tool('Beta')], ['Beta'], 0, 'account');
  const second = toolDeclarationPolicy(
    model,
    [tool('Beta'), tool('Alpha')],
    ['Beta'],
    0,
    'account',
  );
  expect(second).toEqual(first);
  expect(first.tools?.map((t) => t.name)).toEqual(['Alpha', 'Beta']);
  expect(
    toolDeclarationPolicy(
      model,
      Array.from({ length: 129 }, (_, i) => tool(`Tool${i}`)),
      [],
      0,
      'account',
    ).tools,
  ).toBeUndefined();
  expect(
    toolDeclarationPolicy(
      { ...model, baseUrl: 'https://hive.example/v1' },
      [tool('Alpha')],
      [],
      0,
      'account',
    ).tools,
  ).toBeUndefined();
  expect(
    toolDeclarationPolicy({ ...model, contextWindow: 32000 }, [tool('Alpha')], [], 20000, 'account')
      .tools,
  ).toBeUndefined();
  const active = ['Alpha'];
  const context = normalizeContext({
    systemPrompt: 'Stable instructions',
    tools: [tool('Alpha')],
    messages: [],
  });
  const projected = withFixedToolDeclarations(context, first, active);
  expect(projected.messages[0]).toMatchObject({ toolsAdded: first.tools });
  expect(JSON.stringify(projected.messages.at(-1))).toContain('Alpha');
  expect(active).toEqual(['Alpha']);
  expect(context.messages).toHaveLength(1);
});
it('affinity needs explicit capability, preserves caller keys and calls validation after insertion', async () => {
  const input = { sessionId: 'session-7', cacheRetention: 'short' as const };
  expect(withSessionAffinityOptions(input, model.api)).toBe(input);
  const bodies: unknown[] = [];
  const options = withSessionAffinityOptions(
    {
      ...input,
      headers: { 'X-Session-Affinity': 'old' },
      onPayload: (p) => {
        bodies.push(p);
      },
    },
    model.api,
    'headers-and-body',
  );
  expect(options.headers).toEqual({ 'x-session-affinity': 'session-7' });
  const body = { messages: [] };
  expect(await options.onPayload?.(body, model)).toEqual({
    ...body,
    prompt_cache_key: 'session-7',
  });
  expect(body).not.toHaveProperty('prompt_cache_key');
  const existing = { prompt_cache_key: 'caller-set' };
  expect(await options.onPayload?.(existing, model)).toBe(existing);
  expect(bodies).toHaveLength(2);
  expect(
    withSessionAffinityOptions({ ...input, cacheRetention: 'none' }, model.api, 'headers-and-body')
      .headers,
  ).toBeUndefined();
});
