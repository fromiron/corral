import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { startCorralServer } from './app.ts';
import { defaultDecisionProviders } from './decision-providers.ts';
import { createLiveModels } from './live-models.ts';

// `pnpm --filter @corral/server start -- --workspace <dir>`
// Each Run explicitly chooses simulated or live agents; search needs a separate opt-in.

const { values } = parseArgs({
  options: {
    workspace: { type: 'string', default: process.cwd() },
    port: { type: 'string', default: '4317' },
    static: { type: 'string' },
    'mock-delay': { type: 'string', default: '1500' },
    'allow-origin': { type: 'string', multiple: true, default: [] },
    // Simulated agents only: no sign-in, no model calls.
    'no-live': { type: 'boolean', default: false },
    'allow-live-search': { type: 'boolean', default: false },
    'search-request-limit': { type: 'string', default: '10' },
  },
});

const delayMs = Number(values['mock-delay']);
const server = await startCorralServer({
  workspace: resolve(values.workspace),
  port: Number(values.port),
  agents: new ScriptedAgentAdapter({
    turns: 2,
    beforeReply: () => new Promise((done) => setTimeout(done, delayMs)),
  }),
  ...(values.static ? { staticDir: resolve(values.static) } : {}),
  // The same judgment providers as `corral dev` (#21).
  decisionProviders: defaultDecisionProviders(),
  extraOrigins: values['allow-origin'],
  ...(values['no-live'] ? {} : { live: createLiveModels() }),
  ...(values['allow-live-search']
    ? {
        inputs: {
          liveSearch: {
            enabled: true as const,
            apiKey: () => process.env.BRAVE_SEARCH_API_KEY,
            maxRequests: Number(values['search-request-limit']),
          },
        },
      }
    : {}),
});

console.log(`Corral is running. Open this link once to start a session:\n  ${server.bootstrapUrl}`);
const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
