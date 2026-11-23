import type { ProviderAuthView } from '@corral/client';
import { describe, expect, it } from 'vitest';
import {
  connectionState,
  endpointIdFor,
  profileNameFor,
  sortConnections,
  uniqueName,
} from './modelConnections.ts';
import { provider } from './modelTestDom.ts';

describe('a connection row says one thing', () => {
  it('names the method and the model count once connected', () => {
    expect(
      connectionState(
        provider({ signedIn: true, method: 'oauth', subscription: true, modelCount: 8 }),
      ),
    ).toEqual({ kind: 'connected', method: 'subscription', count: 8 });
    expect(
      connectionState(
        provider({ signedIn: true, method: 'api_key', source: 'corral', modelCount: 44 }),
      ),
    ).toEqual({ kind: 'connected', method: 'apiKey', count: 44 });
    expect(
      connectionState(
        provider({ signedIn: true, method: 'api_key', source: 'environment', modelCount: 12 }),
      ),
    ).toEqual({ kind: 'connected', method: 'envKey', count: 12 });
    expect(
      connectionState(
        provider({ signedIn: true, method: 'oauth', source: 'codex-cli', modelCount: 8 }),
      ),
    ).toEqual({ kind: 'connected', method: 'codex', count: 8 });
    expect(
      connectionState(
        provider({
          providerId: 'local',
          endpoint: '127.0.0.1:11434',
          signedIn: true,
          method: 'none',
          modelCount: 3,
          modelFetch: { kind: 'connected', status: 200, fetchedAt: '2026-11-11T00:00:00Z' },
        }),
      ),
    ).toEqual({ kind: 'connected', method: 'keyless', count: 3 });
    // An expiry is nothing to act on: a token about to expire is still connected.
    expect(
      connectionState(
        provider({
          signedIn: true,
          method: 'oauth',
          modelCount: 2,
          expiresAt: '2026-11-11T00:00:00Z',
        }),
      ),
    ).toEqual({ kind: 'connected', method: 'oauth', count: 2 });
  });

  it('names what to do when the person must act', () => {
    expect(connectionState(provider({}))).toMatchObject({
      kind: 'action',
      cause: 'notConnected',
      action: 'connect',
    });
    expect(
      connectionState(
        provider({ login: { state: 'failed', authUrl: null, userCode: null, error: 'x' } }),
      ),
    ).toMatchObject({ kind: 'action', cause: 'signInFailed', action: 'signInAgain' });
    expect(
      connectionState(
        provider({ login: { state: 'waiting', authUrl: null, userCode: null, error: null } }),
      ),
    ).toMatchObject({ kind: 'action', status: 'connecting', action: null });
    // A key entered for another address is not sent to the new one.
    expect(
      connectionState(
        provider({
          providerId: 'hive',
          endpoint: 'new.example.com',
          methods: { oauth: false, apiKey: true },
          endpointChanged: true,
        }),
      ),
    ).toMatchObject({ kind: 'action', cause: 'addressChanged', action: 'enterKeyAgain' });
    const fetched = (kind: NonNullable<ProviderAuthView['modelFetch']>['kind']) =>
      connectionState(
        provider({
          providerId: 'hive',
          endpoint: 'api.example.com',
          methods: { oauth: false, apiKey: true },
          signedIn: true,
          method: 'api_key',
          source: 'corral',
          modelCount: 4,
          modelFetch: { kind, status: 401, fetchedAt: '2026-11-11T00:00:00Z' },
        }),
      );
    expect(fetched('authentication')).toMatchObject({
      kind: 'action',
      cause: 'fetch.authentication',
      action: 'enterKeyAgain',
    });
    expect(fetched('connection')).toMatchObject({ cause: 'fetch.connection', action: 'retry' });
    expect(fetched('redirect')).toMatchObject({ cause: 'fetch.redirect', action: 'editAddress' });
    expect(
      connectionState(
        provider({
          signedIn: true,
          method: 'oauth',
          source: 'codex-cli',
          permissionsOk: false,
          modelCount: 8,
        }),
      ),
    ).toMatchObject({ kind: 'action', cause: 'permissions', action: null });
  });

  it('puts rows that need the person first, then the connected ones, each by name', () => {
    const rows = sortConnections([
      provider({ providerId: 'b', name: 'Beta', signedIn: true, method: 'api_key' }),
      provider({ providerId: 'z', name: 'Zed' }),
      provider({ providerId: 'a', name: 'alpha', signedIn: true, method: 'api_key' }),
      provider({ providerId: 'c', name: 'Charlie' }),
    ]);
    expect(rows.map((row) => row.name)).toEqual(['Charlie', 'Zed', 'alpha', 'Beta']);
  });
});

describe('a new profile is named after its model', () => {
  it('makes the model id a valid name and numbers a taken one', () => {
    expect(profileNameFor('gpt-6-luna', [])).toBe('gpt-6-luna');
    expect(profileNameFor('meta-llama/llama-3.1-8b', [])).toBe('meta-llama-llama-3.1-8b');
    expect(profileNameFor('4o', [])).toBe('model-4o');
    expect(profileNameFor('llama3.2:latest', [])).toBe('llama3.2:latest');
    expect(profileNameFor('gpt-6-luna', ['gpt-6-luna'])).toBe('gpt-6-luna-2');
    expect(profileNameFor('gpt-6-luna', ['gpt-6-luna', 'gpt-6-luna-2'])).toBe('gpt-6-luna-3');
    expect(profileNameFor('x'.repeat(200), []).length).toBeLessThanOrEqual(120);
    expect(uniqueName('a'.repeat(120), ['a'.repeat(120)])).toMatch(/^a+-2$/);
    expect(uniqueName('a'.repeat(120), ['a'.repeat(120)]).length).toBe(120);
  });

  it('gives an added address an id that no provider uses', () => {
    expect(endpointIdFor('Local server', ['openai'])).toBe('local-server');
    expect(endpointIdFor('OpenAI', ['openai'])).toBe('openai-2');
    expect(endpointIdFor('', [])).toBe('endpoint');
  });
});
