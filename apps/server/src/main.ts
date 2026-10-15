import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PiAgentAdapter, processChannel, WORKER_ENTRY } from '@corral/adapter-pi';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { builtinModels, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { type LiveModels, startCorralServer } from './app.ts';
import { FileCredentialStore, installationId, userConfigDir } from './models/index.ts';

// `pnpm --filter @corral/server start -- --workspace <dir>`
// Agents are simulated until the Pi worker lands (P3); nothing leaves this machine.

const { values } = parseArgs({
  options: {
    workspace: { type: 'string', default: process.cwd() },
    port: { type: 'string', default: '4317' },
    static: { type: 'string' },
    'mock-delay': { type: 'string', default: '1500' },
    'allow-origin': { type: 'string', multiple: true, default: [] },
    // Simulated agents only: no sign-in, no model calls.
    'no-live': { type: 'boolean', default: false },
  },
});

// Live runs (C-020, C-058): sign-in is stored in the user's config directory, outside the
// workspace; each execution runs in its own worker process and gets a token per request.
function liveModels(): LiveModels {
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
        credentials: (model) => registry.credentials(model),
      }),
  };
}

const delayMs = Number(values['mock-delay']);
const server = await startCorralServer({
  workspace: resolve(values.workspace),
  port: Number(values.port),
  agents: new ScriptedAgentAdapter({
    turns: 2,
    beforeReply: () => new Promise((done) => setTimeout(done, delayMs)),
  }),
  ...(values.static ? { staticDir: resolve(values.static) } : {}),
  extraOrigins: values['allow-origin'],
  ...(values['no-live'] ? {} : { live: liveModels() }),
});

console.log(`Corral is running. Open this link once to start a session:\n  ${server.bootstrapUrl}`);
const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
