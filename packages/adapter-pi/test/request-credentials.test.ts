import {
  createFauxCore,
  createModels,
  createProvider,
  fauxAssistantMessage,
  type OAuthAuth,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { requestCredentials } from '../src/request-credentials.ts';

// an OAuth-only provider (pi-ai's `openai-codex`) ignores a per-request API key and
// reads its credential from a store. The worker keeps only the current request's token.

function oauthOnly(credentials?: ReturnType<typeof requestCredentials>['store']) {
  const seen: (string | undefined)[] = [];
  let refreshes = 0;
  const faux = createFauxCore({ provider: 'oauth-only', models: [{ id: 'm', name: 'M' }] });
  faux.setResponses([fauxAssistantMessage('ok'), fauxAssistantMessage('ok')]);
  const oauth: OAuthAuth = {
    name: 'OAuth only',
    async login() {
      throw new Error('no login in the worker');
    },
    async refresh(credential) {
      refreshes += 1;
      return credential;
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
  const models = createModels(credentials ? { credentials } : {});
  models.setProvider(
    createProvider({
      id: 'oauth-only',
      name: 'OAuth only',
      auth: { oauth },
      models: faux.models,
      api: {
        stream: faux.stream,
        streamSimple: (model, context, options) => {
          seen.push(options?.apiKey);
          return faux.streamSimple(model, context, options);
        },
      },
    }),
  );
  const model = models.getModel('oauth-only', 'm');
  if (!model) throw new Error('no model');
  return { models, model, seen, refreshes: () => refreshes };
}

const ask = async (setup: ReturnType<typeof oauthOnly>, apiKey: string) => {
  const result = await setup.models
    .streamSimple(
      setup.model,
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      { apiKey },
    )
    .result();
  return result;
};

describe('request credentials in the worker', () => {
  it('an OAuth-only provider gets the request’s token, and it is never refreshed', async () => {
    const { store, use } = requestCredentials();
    const setup = oauthOnly(store);
    use('oauth-only', 'token-1');
    expect((await ask(setup, 'token-1')).stopReason).not.toBe('error');
    use('oauth-only', 'token-2');
    expect((await ask(setup, 'token-2')).stopReason).not.toBe('error');
    expect(setup.seen).toEqual(['token-1', 'token-2']);
    expect(setup.refreshes()).toBe(0);
  });

  it('without it the provider is not configured; the store keeps nothing else', async () => {
    const bare = oauthOnly();
    expect((await ask(bare, 'token-1')).errorMessage).toMatch(/not configured/);
    const { store } = requestCredentials();
    expect(await store.read('oauth-only')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});
