import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InProcessTransport, waitForProjection } from '@corral/core';
import { openReadOnlyDatabase, SqliteRunStore } from '@corral/storage-sqlite';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';

const workspaces: string[] = [];
const servers: CorralServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'corral-owner-'));
  workspaces.push(root);
  return root;
}

async function start(root: string, port = 0) {
  const server = await startCorralServer({
    workspace: root,
    port,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  servers.push(server);
  return server;
}

it.each(['same', 'different'])(
  '[TC-RUN-007-N] refuses a second owner on a %s port before recovery',
  async (portChoice) => {
    const root = workspace();
    const owner = await start(root);
    const definition = linearCorral(['writer']);
    const output = definition.nodes.find((node) => node.type === 'output');
    if (output?.type === 'output') output.requireApproval = true;
    const transport = new InProcessTransport(owner.coordinator);
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'owner_start',
      definition,
      mode: 'mock',
    });
    if (!runId) throw new Error('expected run');
    const waiting = await waitForProjection(transport, runId, (p) => p.status === 'awaiting_user');
    const reader = openReadOnlyDatabase(join(root, '.corral', 'corral.db'));
    try {
      const store = new SqliteRunStore(reader);
      const events = store.readEvents(runId, 0);
      const stored = store.getRun(runId);
      const port = portChoice === 'same' ? Number(new URL(owner.url).port) : 0;
      await expect(start(root, port)).rejects.toThrow(
        'workspace is already owned by another server',
      );
      expect(store.getRun(runId)).toEqual(stored);
      expect(store.readEvents(runId, 0)).toEqual(events);
      const approval = Object.values(waiting.approvals).find((a) => a.status === 'pending');
      if (!approval?.subjectVersionIds[0]) throw new Error('expected approval');
      const receipt = await transport.sendCommand({
        schemaVersion: '0.1',
        commandId: 'owner_approve',
        runId,
        type: 'resolve_approval',
        expectedControlRevision: waiting.controlRevision,
        payload: {
          approvalId: approval.approvalId,
          decision: 'approve',
          subjectVersionId: approval.subjectVersionIds[0],
        },
      });
      expect(receipt.status).not.toBe('rejected');
      expect(
        (await waitForProjection(transport, runId, (p) => p.status === 'succeeded')).status,
      ).toBe('succeeded');
      expect(owner.coordinator.admitting).toBe(true);
    } finally {
      reader.close();
    }
  },
);

it('[TC-RUN-007-N] releases ownership when listening fails', async () => {
  const owner = await start(workspace());
  const root = workspace();
  await expect(start(root, Number(new URL(owner.url).port))).rejects.toThrow('EADDRINUSE');
  expect((await start(root)).coordinator.admitting).toBe(true);
});

it('[TC-RUN-007-H] recovers after the owning process is killed without replaying effects', async () => {
  const root = workspace();
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { startCorralServer } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
    import { InProcessTransport, waitForProjection } from ${JSON.stringify(new URL('../../../packages/core/src/index.ts', import.meta.url).href)};
    import { linearCorral, ScriptedAgentAdapter } from ${JSON.stringify(new URL('../../../packages/testkit/src/index.ts', import.meta.url).href)};
    console.error('owner-readiness: starting-server');
    const server = await startCorralServer({ workspace: process.argv[1], port: 0, agents: new ScriptedAgentAdapter({ turns: 1 }) });
    console.error('owner-readiness: awaiting-user');
    const definition = linearCorral(['writer']);
    definition.nodes.find((n) => n.type === 'output').requireApproval = true;
    const transport = new InProcessTransport(server.coordinator);
    const { runId } = await transport.startRun({ schemaVersion: '0.1', commandId: 'crash_start', definition, mode: 'mock' });
    await waitForProjection(transport, runId, (p) => p.status === 'awaiting_user');
    process.send({ runId });
  `,
      root,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, 'exit');
  try {
    const message = await Promise.race([
      // Match the native Desktop's 30s cold-child startup budget (desktop/src/main.ts).
      // This includes loading the real server modules; it is not a 5s HTTP request.
      once(child, 'message', { signal: AbortSignal.timeout(30_000) })
        .then(([value]) => value as { runId: string })
        .catch((cause) => {
          if (!(cause instanceof Error) || cause.name !== 'AbortError') throw cause;
          const stage = stderr.includes('owner-readiness: awaiting-user')
            ? 'starting the mock run and reaching awaiting_user'
            : stderr.includes('owner-readiness: starting-server')
              ? 'starting the server'
              : 'loading production modules';
          throw new Error(`owner IPC readiness timed out while ${stage}`, { cause });
        }),
      exited.then(() => {
        throw new Error(`owner exited before readiness: ${stderr}`);
      }),
    ]);
    await expect(start(root)).rejects.toThrow('workspace is already owned by another server');
    child.kill('SIGKILL');
    await exited;
    const agents = new ScriptedAgentAdapter({ turns: 1 });
    const calls = vi.spyOn(agents, 'start');
    const recovered = await startCorralServer({ workspace: root, port: 0, agents });
    servers.push(recovered);
    expect(recovered.coordinator.getSnapshot(message.runId).projection.status).toBe('interrupted');
    expect(calls).not.toHaveBeenCalled();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
  // The startup allowance above is separate from the existing crash/recovery test budget.
}, 45_000);
