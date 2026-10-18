import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endpointProvider, memoryChannelPair, PiAgentAdapter, runWorker } from '@corral/adapter-pi';
import type { LspQuery } from '@corral/contracts';
import {
  createFauxCore,
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxToolCall,
  type JsonObject,
  type OAuthAuth,
} from '@earendil-works/pi-ai';
import type { LiveModels } from './app.ts';
import { FileCredentialStore, LayeredCredentialStore } from './models/index.ts';

// OpenAI as pi-ai sees it, with a sign-in flow and models that never touch the network. The
// server tests and the E2E harness use it to exercise sign-in, refresh and live runs.

export const FAKE_REDIRECT_OK = 'http://127.0.0.1:1455/auth/callback?code=ok&state=s1';
export const FAKE_REDIRECT_BAD = 'http://127.0.0.1:1455/auth/callback?code=bad&state=s1';
/** The access token in the fake Codex CLI login (a JWT; the page must never show it). */
export const FAKE_CODEX_ACCESS = fakeJwt(Math.floor(Date.UTC(2099, 0, 1) / 1000));

function fakeJwt(exp: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })}.sig`;
}

export const FAKE_PROFILES = [
  { id: 'model-a', provider: 'openai', model: 'gpt-test-a' },
  { id: 'model-b', provider: 'openai', model: 'gpt-test-b' },
];

export function fakeOpenAI(
  options: {
    env?: Record<string, string>;
    configDir?: string;
    /** Also lay a Codex CLI login (CR-004) under the config directory, read only. */
    codexLogin?: { mode?: number };
    /** Label the models as the Responses API, so they report reasoning levels (CR-021). */
    reasoningApi?: boolean;
  } = {},
) {
  const seen = {
    deviceIds: [] as (string | undefined)[],
    agentNames: [] as (string | undefined)[],
    refreshes: 0,
    tokens: [] as (string | undefined)[],
    /** Requests the host made itself (team drafts, CR-006), not a worker. */
    hostRequests: [] as { maxTokens: number | undefined; text: string }[],
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
    ...(options.reasoningApi ? { api: 'openai-responses' } : {}),
    models: [
      { id: 'gpt-test-a', name: 'Test A', reasoning: true, contextWindow: 1000, maxTokens: 500 },
      { id: 'gpt-test-b', name: 'Test B' },
      { id: 'gpt-test-b-api-only', name: 'Test B (API only)' },
    ],
  });
  const configDir = options.configDir ?? mkdtempSync(join(tmpdir(), 'corral-config-'));
  const own = new FileCredentialStore(configDir);
  const codexPath = join(configDir, 'codex', 'auth.json');
  if (options.codexLogin) {
    mkdirSync(join(configDir, 'codex'), { recursive: true });
    writeFileSync(
      codexPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: 'codex-id-secret',
          access_token: FAKE_CODEX_ACCESS,
          refresh_token: 'codex-refresh-secret',
          account_id: 'acct-test',
        },
        last_refresh: '2026-10-16T00:00:00Z',
      }),
      { mode: options.codexLogin.mode ?? 0o600 },
    );
  }
  // The fake provider is `openai`, so the borrowed login serves it here.
  const credentials = new LayeredCredentialStore(own, codexPath, 'openai');
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
      api: {
        stream: faux.stream,
        streamSimple: (model, context, streamOptions) => {
          seen.hostRequests.push({
            maxTokens: streamOptions?.maxTokens,
            text: JSON.stringify(context.messages),
          });
          return faux.streamSimple(model, context, streamOptions);
        },
      },
    }),
  );

  // Anthropic as pi-ai has it: an API key, and a subscription OAuth Corral must never start.
  const anthropic = createFauxCore({
    provider: 'anthropic',
    models: [{ id: 'claude-test', name: 'Claude Test' }],
  });
  models.setProvider(
    createProvider({
      id: 'anthropic',
      name: 'Anthropic',
      auth: {
        apiKey: envApiKeyAuth('Anthropic API key', ['ANTHROPIC_API_KEY']),
        oauth: {
          name: 'Anthropic (Claude Pro/Max)',
          isSubscription: true,
          async login() {
            throw new Error('Corral must not start Anthropic subscription sign-in');
          },
          async refresh(credential) {
            return credential;
          },
          async toAuth(credential) {
            return { apiKey: credential.access };
          },
        },
      },
      models: anthropic.models,
      api: { stream: anthropic.stream, streamSimple: anthropic.streamSimple },
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
    agents: (registry, harnesses) =>
      new PiAgentAdapter({
        harness: (input) => harnesses.runtimeResources(input),
        spawnSdk: () => {
          const { host, worker } = memoryChannelPair();
          mkdirSync(configDir, { recursive: true });
          const directory = mkdtempSync(join(configDir, 'sdk-fixture-'));
          // Test-only SDK sessions use the same deterministic model and never provider HTTP.
          void import('@corral/adapter-pi/sdk-worker')
            .then(({ runSdkWorker }) =>
              runSdkWorker(worker, {
                directory,
                now: () => Date.now(),
                streamFn: (model, context, streamOptions) => {
                  seen.tokens.push(streamOptions?.apiKey);
                  return faux.streamSimple(model, context, streamOptions);
                },
                resolveModel: (provider, id) => models.getModel(provider, id),
              }),
            )
            .catch(() => worker.kill());
          return host;
        },
        spawn: () => {
          const { host, worker } = memoryChannelPair();
          // Like the real worker: an endpoint (CR-005) is built from its start frame alone.
          const workerModels = createModels();
          runWorker(worker, {
            streamFn: (model, context, streamOptions) => {
              if (model.provider !== 'openai') {
                return workerModels.streamSimple(model, context, streamOptions);
              }
              seen.tokens.push(streamOptions?.apiKey);
              return faux.streamSimple(model, context, streamOptions);
            },
            resolveModel: (provider, id, endpoint) => {
              if (!endpoint) return models.getModel(provider, id);
              workerModels.setProvider(endpointProvider(provider, endpoint));
              return workerModels.getModel(provider, id);
            },
          });
          return host;
        },
        credentials: (model) => registry.credentials(model),
        endpoint: (model) => registry.endpointOf(model),
      }),
  };

  /** Scripts one live step: write `text`, submit it, finish. */
  const answerWith = (
    text: string,
    options: {
      checkId?: string;
      lspQuery?: LspQuery;
      mcpCall?: { name: string; args: JsonObject };
      /** A plain answer to a host request first, such as the auto choice (CR-024). */
      hostReply?: string;
    } = {},
  ) => {
    faux.setResponses([
      ...(options.hostReply !== undefined ? [fauxAssistantMessage(options.hostReply)] : []),
      ...(options.mcpCall
        ? [
            fauxAssistantMessage([fauxToolCall(options.mcpCall.name, options.mcpCall.args)], {
              stopReason: 'toolUse',
            }),
          ]
        : []),
      ...(options.lspQuery
        ? [
            fauxAssistantMessage([fauxToolCall('lsp_query', options.lspQuery)], {
              stopReason: 'toolUse',
            }),
          ]
        : []),
      ...(options.checkId
        ? [
            fauxAssistantMessage([fauxToolCall('run_check', { commandId: options.checkId })], {
              stopReason: 'toolUse',
            }),
          ]
        : []),
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

  /** Scripts one plain text answer (for a host request such as a team draft). */
  const replyText = (text: string) => faux.setResponses([fauxAssistantMessage(text)]);

  return {
    live,
    credentials,
    configDir,
    seen,
    answerWith,
    replyText,
    setResponses: (steps: Parameters<typeof faux.setResponses>[0]) => faux.setResponses(steps),
  };
}

export { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
