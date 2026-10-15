import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryChannelPair, PiAgentAdapter, runWorker } from '@corral/adapter-pi';
import {
  createFauxCore,
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxToolCall,
  type OAuthAuth,
} from '@earendil-works/pi-ai';
import type { LiveModels } from './app.ts';
import { FileCredentialStore } from './models/index.ts';

// OpenAI as pi-ai sees it, with a sign-in flow and models that never touch the network. The
// server tests and the E2E harness use it to exercise sign-in, refresh and live runs.

export const FAKE_REDIRECT_OK = 'http://127.0.0.1:1455/auth/callback?code=ok&state=s1';
export const FAKE_REDIRECT_BAD = 'http://127.0.0.1:1455/auth/callback?code=bad&state=s1';
export const FAKE_PROFILES = [
  { id: 'model-a', provider: 'openai', model: 'gpt-test-a' },
  { id: 'model-b', provider: 'openai', model: 'gpt-test-b' },
];

export function fakeOpenAI(options: { env?: Record<string, string>; configDir?: string } = {}) {
  const seen = {
    deviceIds: [] as (string | undefined)[],
    agentNames: [] as (string | undefined)[],
    refreshes: 0,
    tokens: [] as (string | undefined)[],
  };
  const oauth: OAuthAuth = {
    name: 'OpenAI (ChatGPT subscription)',
    isSubscription: true,
    loginLabel: 'Sign in with ChatGPT',
    async login(interaction, loginOptions) {
      seen.deviceIds.push(loginOptions?.getDeviceId?.());
      seen.agentNames.push(loginOptions?.agentName);
      interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/authorize?state=s1' });
      const redirect = await interaction.prompt({
        type: 'manual_code',
        message: 'Paste the redirect URL',
        signal: interaction.signal,
      });
      if (!redirect.includes('code=ok')) {
        throw new Error('OpenAI OAuth token request failed (400): {"refresh_token":"leaked-body"}');
      }
      return {
        type: 'oauth',
        access: 'access-1-secret',
        refresh: 'refresh-1-secret',
        expires: Date.now() + 3_600_000,
      };
    },
    async refresh() {
      seen.refreshes += 1;
      return {
        type: 'oauth',
        access: `access-${seen.refreshes + 1}-secret`,
        refresh: 'refresh-2-secret',
        expires: Date.now() + 3_600_000,
      };
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
  const faux = createFauxCore({
    provider: 'openai',
    models: [
      { id: 'gpt-test-a', name: 'Test A', reasoning: true, contextWindow: 1000, maxTokens: 500 },
      { id: 'gpt-test-b', name: 'Test B' },
      { id: 'gpt-test-b-api-only', name: 'Test B (API only)' },
    ],
  });
  const configDir = options.configDir ?? mkdtempSync(join(tmpdir(), 'corral-config-'));
  const credentials = new FileCredentialStore(configDir);
  const models = createModels({
    credentials,
    authContext: { env: async (name) => options.env?.[name], fileExists: async () => false },
  });
  models.setProvider(
    createProvider({
      id: 'openai',
      name: 'OpenAI',
      auth: { apiKey: envApiKeyAuth('OpenAI API key', ['OPENAI_API_KEY']), oauth },
      models: faux.models,
      api: { stream: faux.stream, streamSimple: faux.streamSimple },
    }),
  );

  const live: LiveModels = {
    models,
    credentials,
    configDir,
    // What a subscription sign-in may call, like pi-ai's ChatGPT (Codex) catalog.
    subscriptionModels: (providerId) =>
      providerId === 'openai' ? new Set(['gpt-test-a', 'gpt-test-b']) : null,
    getDeviceId: () => '00000000-0000-4000-8000-000000000001',
    agents: (registry) =>
      new PiAgentAdapter({
        spawn: () => {
          const { host, worker } = memoryChannelPair();
          runWorker(worker, {
            streamFn: (model, context, streamOptions) => {
              seen.tokens.push(streamOptions?.apiKey);
              return faux.streamSimple(model, context, streamOptions);
            },
            resolveModel: (provider, id) => models.getModel(provider, id),
          });
          return host;
        },
        credentials: (model) => registry.credentials(model),
      }),
  };

  /** Scripts one live step: write `text`, submit it, finish. */
  const answerWith = (text: string) => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_artifact', { text })], { stopReason: 'toolUse' }),
      (context) => {
        const written =
          [...JSON.stringify(context.messages).matchAll(/artv_[a-f0-9]{32}/g)].at(-1)?.[0] ?? '';
        return fauxAssistantMessage(
          [fauxToolCall('submit_result', { artifactVersionIds: [written] })],
          { stopReason: 'toolUse' },
        );
      },
      fauxAssistantMessage('Done.'),
    ]);
  };

  return { live, credentials, configDir, seen, answerWith };
}
