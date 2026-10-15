import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { startCorralServer } from './app.ts';

// `pnpm --filter @corral/server start -- --workspace <dir>`
// Agents are simulated until the Pi worker lands (P3); nothing leaves this machine.

const { values } = parseArgs({
  options: {
    workspace: { type: 'string', default: process.cwd() },
    port: { type: 'string', default: '4317' },
    static: { type: 'string' },
    'mock-delay': { type: 'string', default: '1500' },
    'allow-origin': { type: 'string', multiple: true, default: [] },
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
  extraOrigins: values['allow-origin'],
});

console.log(`Corral is running. Open this link once to start a session:\n  ${server.bootstrapUrl}`);
const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
