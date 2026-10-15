import { PiAgentAdapter, processChannel, WORKER_ENTRY } from '@corral/adapter-pi';
import { builtinModels, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import type { LiveModels } from './app.ts';
import { FileCredentialStore, installationId, userConfigDir } from './models/index.ts';

// Live runs (C-020, C-058): sign-in is stored in the user's config directory, outside the
// workspace; each execution runs in its own worker process and gets a token per request.
export function createLiveModels(): LiveModels {
  const configDir = userConfigDir();
  const credentials = new FileCredentialStore(configDir);
  return {
    models: builtinModels({ credentials }),
    credentials,
    configDir,
    getDeviceId: () => installationId(configDir),
    // A ChatGPT sign-in reaches only the models of pi-ai's ChatGPT-account (Codex) catalog.
    subscriptionModels: (providerId) =>
      providerId === 'openai' ? new Set(getBuiltinModels('openai-codex').map((m) => m.id)) : null,
    agents: (registry) =>
      new PiAgentAdapter({
        spawn: () => processChannel(WORKER_ENTRY),
        cancelGraceMs: 9_000,
        credentials: (model) => registry.credentials(model),
      }),
  };
}
