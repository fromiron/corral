import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLiveModels, defaultLocalIntelligence, startCorralServer } from '@corral/server';
import { ScriptedAgentAdapter } from '@corral/testkit';

// IPC is the only place the bootstrap capability leaves this process. Never print it.
const [workspace, staticDir, port = '0', mockOnly = 'false', worktreeRoot] = process.argv.slice(2);
let server;
let stopping = false;
let cleanupFailed = false;
let cleanupHold;
const send = (message) => {
  if (process.connected) process.send?.(message, () => {});
};
const retainFailedCleanup = (error) => {
  cleanupFailed ||= error?.code === 'RESOURCE_CLEANUP_FAILED';
  if (cleanupFailed && !cleanupHold) cleanupHold = setInterval(() => {}, 1000);
};
const options = {
  workspace,
  staticDir,
  worktreeRoot,
  host: '127.0.0.1',
  allowSharedDevelopment: true,
  port: Number(port),
  agents: new ScriptedAgentAdapter({
    turns: 2,
    beforeReply: () => new Promise((done) => setTimeout(done, 300)),
  }),
  localIntelligence: defaultLocalIntelligence(),
  ...(mockOnly === 'true' ? {} : { live: createLiveModels() }),
};
try {
  try {
    server = await startCorralServer(options);
  } catch (error) {
    if (error?.code !== 'EADDRINUSE' || !options.port) throw error;
    server = await startCorralServer({ ...options, port: 0 });
  }
  const git = await promisify(execFile)('git', ['--version'], {
    timeout: 3000,
    windowsHide: true,
  }).then(
    () => true,
    () => false,
  );
  send({
    type: 'ready',
    url: server.url,
    bootstrapUrl: server.bootstrapUrl,
    git,
    node: process.versions.node,
  });
} catch (error) {
  retainFailedCleanup(error);
  send({
    type: 'failed',
    cleanupFailed,
    reason: 'The workspace could not be opened. It may be in use, inaccessible, or incompatible.',
  });
  if (!cleanupFailed) {
    process.exitCode = 1;
    process.disconnect?.();
  }
}
const stop = async () => {
  if (cleanupFailed) {
    send({ type: 'stop-failed', cleanupFailed: true });
    return;
  }
  if (stopping) return;
  stopping = true;
  try {
    await server?.close();
    process.exit(0);
  } catch (error) {
    stopping = false;
    retainFailedCleanup(error);
    send({ type: 'stop-failed', cleanupFailed });
  }
};
process.on('message', (message) => {
  if (cleanupFailed && message?.type !== 'stop') {
    send({
      type: message?.type === 'stop-if-idle' ? 'stop-failed' : message?.type,
      id: message?.id,
      cleanupFailed: true,
      error: 'Resource cleanup is incomplete.',
    });
    return;
  }
  if (message?.type === 'update-status') {
    send({
      type: 'update-status',
      id: message.id,
      storageVersion: server?.desktopStorageVersion(),
    });
  }
  if (message?.type === 'stop-if-idle') {
    if (stopping) send({ type: 'stop-refused' });
    else {
      stopping = true;
      void server
        .closeIfIdle(true)
        .then((ready) => {
          if (ready) process.exit(0);
          stopping = false;
          send({ type: 'stop-refused' });
        })
        .catch((error) => {
          stopping = false;
          retainFailedCleanup(error);
          send({ type: cleanupFailed ? 'stop-failed' : 'stop-refused', cleanupFailed });
        });
    }
  }
  if (message?.type === 'preview-target') {
    void Promise.resolve()
      .then(() => server?.desktopPreviewTarget(message.sessionId, message.leaseId))
      .then((target) => {
        send({ type: 'preview-target', id: message.id, target, error: !target });
      })
      .catch(() => {
        send({ type: 'preview-target', id: message.id, error: true });
      });
  }
  if (message?.type === 'status') {
    const runs =
      server?.coordinator
        .listRuns()
        .filter((r) => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.status))
        .map((r) => ({
          runId: r.runId,
          sessionId: r.sessionId,
          status: r.status,
          title: [...(server.coordinator.getRunSnapshot(r.runId)?.definition.input.brief ?? '')]
            .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char))
            .join('')
            .slice(0, 80),
          controlRevision: server.coordinator.getSnapshot(r.runId).projection.controlRevision,
        })) ?? [];
    send({ type: 'status', id: message.id, active: runs.length, runs });
  }
  if (message?.type === 'cancel-run') {
    try {
      if (!Number.isInteger(message.controlRevision) || message.controlRevision < 0)
        throw new Error('A current run revision is required');
      const receipt = server?.coordinator.submit({
        schemaVersion: '0.1',
        commandId: `desktop_${message.id}`,
        runId: message.runId,
        expectedControlRevision: message.controlRevision,
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason: 'User cancelled from desktop tray' },
      });
      send({ type: 'cancel-result', id: message.id, error: !receipt || !!receipt.error });
    } catch {
      send({ type: 'cancel-result', id: message.id, error: true });
    }
  }
  if (message?.type === 'stop') void stop();
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
