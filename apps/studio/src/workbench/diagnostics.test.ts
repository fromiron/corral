import type { LocalAiView, ModelProfileView, ProviderAuthView } from '@corral/client';
import { describe, expect, it } from 'vitest';
import {
  type DiagnosticsReport,
  diagnosticRows,
  diagnosticsSummary,
  displayVersion,
} from './diagnostics.ts';

const provider = (patch: Partial<ProviderAuthView> = {}): ProviderAuthView => ({
  providerId: 'openai',
  name: 'OpenAI',
  signedIn: true,
  method: 'api_key',
  methods: { oauth: false, apiKey: true },
  endpoint: null,
  endpointChanged: false,
  connectionTest: null,
  subscription: false,
  expiresAt: null,
  login: null,
  source: 'corral',
  permissionsOk: true,
  ...patch,
});

const profile = (patch: Partial<ModelProfileView> = {}): ModelProfileView => ({
  profileId: 'default',
  provider: 'openai',
  providerName: 'OpenAI',
  modelId: 'gpt-5',
  modelName: 'GPT-5',
  available: true,
  reasoning: true,
  contextWindow: 1000,
  maxOutputTokens: 100,
  method: 'api_key',
  keyConfigured: true,
  subscriptionSupported: null,
  ...patch,
});

const localAi = (patch: Partial<LocalAiView> = {}): LocalAiView => ({
  release: 'corral-local-ai-2',
  models: { meeting: 'Meeting model' },
  state: 'ready',
  downloadBytes: null,
  progress: null,
  error: null,
  ...patch,
});

const MESSAGE_BODY = 'Please rewrite my private diary entry about the merger';
const secrets = [
  'sk-live-1234567890abcdef',
  'ghp_abcdefghijklmnop',
  'Bearer eyJhbGciOiJIUzI1NiJ9',
  '#bootstrap=',
  'bootstrap-token-value',
  '/home/',
  'C:\\',
  'diary',
  'merger',
  'internal.example',
  'code=',
];

/** A report whose free-text and identifying fields all carry something that must not leave. */
const leaky: DiagnosticsReport = {
  runtime: { mode: 'server', version: '1.4.0#bootstrap=bootstrap-token-value', live: true },
  models: {
    state: 'ready',
    providers: [
      provider({
        providerId: 'custom-sk-live-1234567890abcdef',
        name: `Endpoint ${MESSAGE_BODY}`,
        endpoint: 'internal.example:8443',
        method: 'oauth',
        connectionTest: { kind: 'authentication', status: 401, checkedAt: '2026-11-09T00:00:00Z' },
        login: {
          state: 'failed',
          authUrl: 'https://auth.internal.example/?code=ghp_abcdefghijklmnop',
          error: `Bearer eyJhbGciOiJIUzI1NiJ9 rejected at /home/bell/.corral/auth.json: ${MESSAGE_BODY}`,
        } as ProviderAuthView['login'],
      }),
      provider({ providerId: 'anthropic', name: 'Anthropic', signedIn: false, method: null }),
    ],
    profiles: [
      profile({ profileId: 'C:\\Users\\bell\\profile', modelName: MESSAGE_BODY }),
      profile({ profileId: 'second', available: false }),
    ],
  },
  folder: {
    state: 'bound',
    path: '/home/bell/private/merger-project',
    trusted: true,
    missing: false,
    isGit: true,
  },
  pathEngine: { state: 'loaded', status: { engine: 'builtIn' } },
  localAi: {
    state: 'loaded',
    view: localAi({
      state: 'error',
      error: `failed to open C:\\Users\\bell\\models\\x.bin with token sk-live-1234567890abcdef: ${MESSAGE_BODY}`,
    }),
  },
};

describe('diagnostics summary', () => {
  it('never carries a key, token, bootstrap fragment, local path or message body', () => {
    const summary = diagnosticsSummary(leaky);
    for (const secret of secrets) expect(summary).not.toContain(secret);
    // Where a path belongs, the summary says one exists without naming it.
    expect(summary).toContain('<local path>');
  });

  it('still says what state each part is in', () => {
    const summary = diagnosticsSummary(leaky);
    expect(summary).toContain('runtime: local server');
    expect(summary).toContain('model connection: connected');
    expect(summary).toContain('authentication');
    expect(summary).toContain('project source folder: linked');
    expect(summary).toContain('trusted');
    expect(summary).toContain('file path engine: built-in');
    expect(summary).toContain('local AI: error');
  });

  it('keeps a Windows path and a development build out as well', () => {
    const summary = diagnosticsSummary({
      ...leaky,
      runtime: { mode: 'server', version: '0.0.0', live: true },
      folder: {
        state: 'bound',
        path: 'C:\\Users\\bell\\merger',
        trusted: false,
        missing: true,
        isGit: false,
      },
    });
    expect(summary).not.toContain('C:\\');
    expect(summary).not.toContain('merger');
    expect(summary).toContain('development build');
    expect(summary).toContain('missing');
  });

  it('names only the release number when the version carries a suffix', () => {
    for (const version of ['1.4.0+sk-live-1234567890abcdef', '1.4.0-ghp_abc']) {
      const summary = diagnosticsSummary({
        ...leaky,
        runtime: { mode: 'server', version, live: true },
      });
      expect(summary).toContain('version 1.4.0');
      for (const secret of ['sk-live', '1234567890abcdef', 'ghp_', '1.4.0+', '1.4.0-'])
        expect(summary).not.toContain(secret);
      expect(displayVersion(version)).toBe('1.4.0');
    }
  });

  it('says a part needs the local server in the browser demo', () => {
    const report: DiagnosticsReport = {
      runtime: { mode: 'browser', version: null, live: false },
      models: { state: 'server-only' },
      folder: { state: 'no-project' },
      pathEngine: { state: 'loaded', status: { engine: 'builtIn' } },
      localAi: { state: 'server-only' },
    };
    const summary = diagnosticsSummary(report);
    expect(summary).toContain('runtime: browser demo');
    expect(summary).toContain('model connection: available with the local server');
    expect(summary).toContain('local AI: available with the local server');
    const rows = diagnosticRows(report);
    expect(rows.find((row) => row.id === 'models')?.status).toBe('serverOnly');
    expect(rows.find((row) => row.id === 'localAi')?.status).toBe('serverOnly');
  });
});

describe('diagnostic rows', () => {
  it('points each problem at its existing recovery', () => {
    const rows = diagnosticRows({
      runtime: { mode: 'server', version: '1.0.0', live: true },
      models: {
        state: 'ready',
        providers: [provider({ signedIn: false, method: null })],
        profiles: [profile({ method: null })],
      },
      folder: { state: 'unbound' },
      pathEngine: { state: 'loaded', status: { engine: 'builtIn' } },
      localAi: { state: 'loaded', view: localAi({ state: 'missing' }) },
    });
    const row = (id: string) => rows.find((value) => value.id === id);
    expect(row('models')).toMatchObject({ status: 'noModel', tone: 'attention', action: 'models' });
    expect(row('folder')).toMatchObject({ status: 'unbound', action: 'workspace' });
    expect(row('localAi')).toMatchObject({ status: 'missing', action: 'models' });
    expect(row('pathEngine')).toMatchObject({ status: 'builtIn', tone: 'ok' });
  });

  it('counts a subscription sign-in that cannot use a model as not ready, like the sidebar', () => {
    const rows = diagnosticRows({
      runtime: { mode: 'server', version: '1.0.0', live: true },
      models: {
        state: 'ready',
        providers: [provider({ method: 'oauth' })],
        profiles: [profile({ method: 'oauth', subscriptionSupported: false })],
      },
      folder: { state: 'no-project' },
      pathEngine: { state: 'loaded', status: { engine: 'builtIn' } },
      localAi: { state: 'loaded', view: localAi() },
    });
    expect(rows.find((value) => value.id === 'models')?.status).toBe('noModel');
  });

  it("shows the server's path engine and why it fell back", () => {
    const report = (pathEngine: DiagnosticsReport['pathEngine']): DiagnosticsReport => ({
      ...leaky,
      pathEngine,
    });
    const row = (pathEngine: DiagnosticsReport['pathEngine']) =>
      diagnosticRows(report(pathEngine)).find((value) => value.id === 'pathEngine');
    expect(row({ state: 'loaded', status: { engine: 'fff' } })).toMatchObject({
      status: 'fff',
      tone: 'ok',
      causes: [],
    });
    expect(row({ state: 'loaded', status: { engine: 'builtIn', reason: 'timeBudget' } })).toEqual({
      id: 'pathEngine',
      status: 'builtIn',
      tone: 'attention',
      causes: [{ kind: 'pathFallback', reason: 'timeBudget' }],
    });
    expect(row({ state: 'loading' })).toMatchObject({ status: 'loading', tone: 'neutral' });
    expect(row({ state: 'failed' })).toMatchObject({
      status: 'failed',
      tone: 'error',
      action: 'retry',
    });
    const summary = diagnosticsSummary(
      report({ state: 'loaded', status: { engine: 'builtIn', reason: 'loadFailed' } }),
    );
    expect(summary).toContain('file path engine: built-in · fallback loadFailed');
    expect(diagnosticsSummary(report({ state: 'loaded', status: { engine: 'fff' } }))).toContain(
      'file path engine: FFF',
    );
  });
});
