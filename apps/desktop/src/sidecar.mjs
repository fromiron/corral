import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLiveModels, defaultDecisionProviders, startCorralServer } from '@corral/server';
import { ScriptedAgentAdapter } from '@corral/testkit';

// IPC is the only place the bootstrap capability leaves this process. Never print it.
const [workspace, staticDir, port = '0', mockOnly = 'false', worktreeRoot] = process.argv.slice(2);
let server;
let stopping = false;
const options = {
  workspace,
  staticDir,
  worktreeRoot,
  host: '127.0.0.1',
  port: Number(port),
  agents: new ScriptedAgentAdapter({
    turns: 2,
    beforeReply: () => new Promise((done) => setTimeout(done, 300)),
  }),
  decisionProviders: defaultDecisionProviders(),
  ...(mockOnly === 'true' ? {} : { live: createLiveModels() }),
};
try {
  try {
    server = await startCorralServer(options);
  } catch (error) {
    if (error?.code !== 'EADDRINUSE' || !options.port) throw error;
    server = await startCorralServer({ ...options, port: 0 });
  }
  const git = await promisify(execFile)('git', ['--version'], { timeout: 3000 }).then(
    () => true,
    () => false,
  );
  process.send?.({
    type: 'ready',
    url: server.url,
    bootstrapUrl: server.bootstrapUrl,
    git,
    node: process.versions.node,
  });
} catch {
  process.send?.({
    type: 'failed',
    reason: 'The workspace could not be opened. It may be in use, inaccessible, or incompatible.',
  });
  process.exitCode = 1;
  process.disconnect?.();
}
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server?.close();
  process.exit(0);
};
process.on('message', (message) => {
  if (message?.type === 'status') {
    const active =
      server?.coordinator
        .listRuns()
        .filter((r) => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.status))
        .length ?? 0;
    process.send?.({ type: 'status', id: message.id, active });
  }
  if (message?.type === 'stop') void stop();
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
