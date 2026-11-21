import { type TeamAssistantRequest, unusableTeamProposal } from '@corral/contracts';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { expect, it, vi } from 'vitest';
import { endpointsFrom, registerEndpoints } from '../src/models/endpoints.ts';
import { ModelRegistry } from '../src/models/registry.ts';

// The team assistant asks at the lowest reasoning level its model offers
// (docs/specs/features/team-assistant.md, 추론 단계): off where it can be switched off, the lowest
// level otherwise, and no level for a model that offers none.

const DEEPSEEK = 'deepseek-ai/deepseek-v4.1-flash-1017';
const GLM = 'zai-org/glm-5.3-flash';
const catalog = {
  agents: [
    {
      id: 'a1',
      name: 'Writer',
      changesFiles: false,
      runsCommands: false,
      output: 'draft' as const,
      skills: [],
    },
  ],
  skills: [],
};
const create: TeamAssistantRequest = {
  operationId: 'reasoning',
  mode: 'create',
  messages: [{ role: 'user', content: 'Write a notice.' }],
  catalog,
};
const edit: TeamAssistantRequest = {
  operationId: 'reasoning-edit',
  mode: 'edit',
  messages: [{ role: 'user', content: 'Who submits?' }],
  team: { roles: [], outputs: [], hasSharedOutrider: false, brief: '' },
};

/** One assistant exchange through Pi's real chat completions client: the body sent, the result. */
async function exchange(
  baseUrl: string,
  model: string,
  request: TeamAssistantRequest,
  answer: { content: string; finish: string } = {
    content: '{"kind":"describe","topic":"submitter"}',
    finish: 'stop',
  },
) {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const endpoints = endpointsFrom([
    { id: 'fixture', name: 'Fixture', baseUrl, access: 'none', models: [{ id: model }] },
  ]);
  registerEndpoints(models, endpoints);
  const registry = new ModelRegistry(models, [{ id: 'chosen', provider: 'fixture', model }], {
    credentials,
    endpoints,
    getDeviceId: () => 'fixture',
  });
  await registry.refreshStatus();
  const bodies: Record<string, unknown>[] = [];
  const spy = vi.spyOn(models, 'streamSimple').mockImplementation((chosen, context, options) =>
    streamSimple(
      chosen as never,
      context as never,
      {
        ...options,
        apiKey: 'fixture-key',
        maxRetries: 0,
        fetch: async (_input: unknown, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(
            [
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer.content }, finish_reason: answer.finish }] })}`,
              'data: [DONE]',
              '',
            ].join('\n\n'),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      } as never,
    ),
  );
  try {
    const result = await registry.assistTeam(request);
    expect(bodies).toHaveLength(1);
    return { body: bodies[0] as Record<string, unknown>, result };
  } finally {
    spy.mockRestore();
  }
}

/** The body the assistant route sends for one model. */
const sentBody = async (baseUrl: string, model: string, request: TeamAssistantRequest) =>
  (await exchange(baseUrl, model, request)).body;

it.each([create, edit])('Hive DeepSeek is asked with reasoning off ($mode)', async (request) => {
  const body = await sentBody('https://api-cdn.thehive.ai/api/v3', DEEPSEEK, request);
  expect(body.reasoning_effort).toBe('none');
});

it.each([create, edit])('Hive GLM is asked at its lowest level, low ($mode)', async (request) => {
  const body = await sentBody('https://api-cdn.thehive.ai/api/v3', GLM, request);
  expect(body.reasoning_effort).toBe('low');
  expect(body).toHaveProperty('max_completion_tokens');
  expect(body).not.toHaveProperty('max_tokens');
});

it.each([create, edit])(
  'a model with no levels is asked with no reasoning field ($mode)',
  async (request) => {
    const body = await sentBody('https://router.example.test/v1', 'plain-model', request);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('thinking');
  },
);

it('reads a reply the provider stopped at the output limit as cut off', async () => {
  const { result } = await exchange('https://api-cdn.thehive.ai/api/v3', GLM, create, {
    content: '{"kind":"plan","plan":{"name":"Not',
    finish: 'length',
  });
  expect(result).toMatchObject({ ok: false, message: unusableTeamProposal('cut_off') });
});
