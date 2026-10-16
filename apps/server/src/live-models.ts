import { PiAgentAdapter, processChannel, WORKER_ENTRY } from '@corral/adapter-pi';
import { builtinModels, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import type { LiveModels } from './app.ts';
import {
  CODEX_PROVIDER,
  codexAuthPath,
  defaultProfilesFor,
  FileCredentialStore,
  installationId,
  LayeredCredentialStore,
  readCodexLogin,
  userConfigDir,
} from './models/index.ts';

// Live runs (C-020, C-058): sign-in is stored in the user's config directory, outside the
// workspace; each execution runs in its own worker process and gets a token per request.
export function createLiveModels(): LiveModels {
  const configDir = userConfigDir();
  const own = new FileCredentialStore(configDir);
  // Corral's own sign-in first; otherwise the Codex CLI login, read only (CR-004).
  const codexPath = codexAuthPath();
  const credentials = new LayeredCredentialStore(own, codexPath);
  return {
    models: builtinModels({ credentials }),
    credentials,
    configDir,
    getDeviceId: () => installationId(configDir),
    // A ChatGPT sign-in reaches only the models of pi-ai's ChatGPT-account (Codex) catalog.
    subscriptionModels: (providerId) =>
      providerId === 'openai' || providerId === CODEX_PROVIDER
        ? new Set(getBuiltinModels(CODEX_PROVIDER).map((m) => m.id))
        : null,
    defaultProfiles: async () =>
      defaultProfilesFor({
        ownOpenAI: (await own.read('openai').catch(() => undefined)) !== undefined,
        codexLogin: readCodexLogin(codexPath).state === 'found',
      }),
    agents: (registry) =>
      new PiAgentAdapter({
        spawn: () => processChannel(WORKER_ENTRY),
        cancelGraceMs: 9_000,
        credentials: (model) => registry.credentials(model),
        endpoint: (model) => registry.endpointOf(model),
      }),
  };
}
