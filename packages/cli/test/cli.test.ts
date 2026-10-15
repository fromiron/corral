import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Coordinator, InProcessTransport, waitForProjection } from '@corral/core';
import { startCorralServer } from '@corral/server';
import { openReadOnlyDatabase, SqliteRunStore } from '@corral/storage-sqlite';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, watchRun } from '../src/index.ts';

const directories: string[] = [];
function workspace() {
  const path = mkdtempSync(join(tmpdir(), 'corral-cli-'));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function runtime(beforeReply?: () => Promise<void>) {
  return new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1, ...(beforeReply ? { beforeReply } : {}) }),
    }),
  );
}

describe('CLI command/query parity', () => {
  it('[TC-DX-001-N] rejects concurrent startup without corrupting the owner and permits history queries', async () => {
    const cwd = workspace();
    const definition = linearCorral(['writer']);
    const outputNode = definition.nodes.find((node) => node.type === 'output');
    if (outputNode?.type === 'output') outputNode.requireApproval = true;
    const path = join(cwd, 'workflow.json');
    writeFileSync(path, JSON.stringify(definition));
    const staticDir = join(cwd, 'studio');
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, 'index.html'), '<head></head>');
    const owner = await startCorralServer({
      workspace: cwd,
      port: 0,
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    const transport = new InProcessTransport(owner.coordinator);
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cli_owner',
      definition,
      mode: 'mock',
    });
    if (!runId) throw new Error('expected run');
    const waiting = await waitForProjection(transport, runId, (p) => p.status === 'awaiting_user');
    const db = openReadOnlyDatabase(join(cwd, '.corral', 'corral.db'));
    const store = new SqliteRunStore(db);
    const before = store.getRun(runId);
    const events = store.readEvents(runId, 0);
    const output: string[] = [];
    const io = {
      cwd,
      write: (line: string) => output.push(line),
      signal: new AbortController().signal,
    };
    try {
      expect(
        await runCli(
          ['run', path, '--demo', '--port', new URL(owner.url).port, '--static', staticDir],
          io,
        ),
      ).toBe(1);
      expect(store.getRun(runId)).toEqual(before);
      expect(store.readEvents(runId, 0)).toEqual(events);
      expect(await runCli(['inspect', runId], io)).toBe(0);
      expect(JSON.parse(output.at(-1) ?? '{}').status).toBe('awaiting_user');
      expect(await runCli(['export', runId, '--private'], io)).toBe(0);
      expect(JSON.parse(output.at(-1) ?? '{}').visibility).toBe('private');
      expect(store.readEvents(runId, 0)).toEqual(events);
      const approval = Object.values(waiting.approvals).find((a) => a.status === 'pending');
      if (!approval?.subjectVersionIds[0]) throw new Error('expected approval');
      const receipt = await transport.sendCommand({
        schemaVersion: '0.1',
        commandId: 'cli_owner_approve',
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
      await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
    } finally {
      db.close();
      await owner.close();
    }
  });

  it('[TC-DX-001-H] validates without starting a server and runs mock to terminal', async () => {
    const cwd = workspace();
    const path = join(cwd, 'workflow.json');
    writeFileSync(path, JSON.stringify(linearCorral(['writer'])));
    const output: string[] = [];
    const io = {
      cwd,
      write: (line: string) => output.push(line),
      signal: new AbortController().signal,
    };
    expect(await runCli(['validate', path], io)).toBe(0);
    expect(await runCli(['run', path, '--demo', '--port', '0'], io)).toBe(0);
    expect(output.some((line) => line.includes('succeeded'))).toBe(true);
    const db = openReadOnlyDatabase(join(cwd, '.corral', 'corral.db'));
    const run = new SqliteRunStore(db).listRuns()[0];
    db.close();
    if (!run) throw new Error('expected recorded run');
    expect(await runCli(['inspect', run.runId], io)).toBe(0);
    expect(await runCli(['export', run.runId, '--redact'], io)).toBe(0);
    expect(JSON.parse(output.at(-1) ?? '{}').visibility).toBe('public');
    expect(await runCli(['export', run.runId, '--private'], io)).toBe(0);
    const archivePath = join(cwd, 'archive.json');
    writeFileSync(archivePath, output.at(-1) ?? '{}');
    expect(await runCli(['inspect', '--archive', archivePath], io)).toBe(0);
    expect(JSON.parse(output.at(-1) ?? '{}').projection.status).toBe('succeeded');
    expect(await runCli(['export', 'missing', '--redact'], io)).toBe(1);
  });

  it('[TC-DX-001-N] the executable handles SIGINT and persists cancellation before exiting', async () => {
    const cwd = workspace();
    const definition = linearCorral(['writer']);
    const output = definition.nodes.find((node) => node.type === 'output');
    if (output?.type === 'output') output.requireApproval = true;
    const path = join(cwd, 'workflow.json');
    writeFileSync(path, JSON.stringify(definition));
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../src/main.ts', import.meta.url)),
        'run',
        path,
        '--demo',
        '--watch',
        '--port',
        '0',
      ],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let interrupted = false;
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!interrupted && stdout.includes('awaiting_user')) {
        interrupted = true;
        child.kill('SIGINT');
      }
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.once('exit', done);
      child.once('error', reject);
    });
    expect(interrupted).toBe(true);
    expect(code).toBe(130);
    const db = openReadOnlyDatabase(join(cwd, '.corral', 'corral.db'));
    try {
      expect(new SqliteRunStore(db).listRuns().map((run) => run.status)).toEqual(['cancelled']);
    } finally {
      db.close();
    }
  }, 15_000);

  it('[TC-DX-001-N] reports invalid input without echoing a path or raw user input', async () => {
    const cwd = workspace();
    const path = join(cwd, 'private-file.json');
    writeFileSync(path, '{secret-user-body');
    const output: string[] = [];
    expect(
      await runCli(['validate', path], {
        cwd,
        write: (line) => output.push(line),
        signal: new AbortController().signal,
      }),
    ).toBe(1);
    expect(output.join('')).not.toContain(cwd);
    expect(output.join('')).not.toContain('secret-user-body');
  });

  it('[TC-DX-001-H] terminal approval resolves the same approvalId without automatic approval', async () => {
    const transport = runtime();
    const definition = linearCorral(['writer']);
    const output = definition.nodes.find((n) => n.type === 'output');
    if (output?.type === 'output') output.requireApproval = true;
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_start',
      definition,
      mode: 'mock',
    });
    if (!runId) throw new Error('expected run');
    const waiting = await waitForProjection(transport, runId, (p) => p.status === 'awaiting_user');
    let line: (input: string) => void = () => {};
    const done = watchRun(transport, runId, {
      write() {},
      signal: new AbortController().signal,
      commandId: () => 'cmd_approve',
      onLine: (listener) => {
        line = listener;
        return () => {};
      },
    });
    await Promise.resolve();
    const approval = Object.values(waiting.approvals).find((a) => a.status === 'pending');
    if (!approval) throw new Error('expected pending approval');
    expect(
      (await transport.getSnapshot(runId)).projection.approvals[approval.approvalId]?.status,
    ).toBe('pending');
    line(`approve ${approval.approvalId}`);
    expect((await done).status).toBe('succeeded');
    expect(
      (await transport.getSnapshot(runId)).projection.approvals[approval.approvalId]?.status,
    ).toBe('approved');
  });

  it('[TC-DX-001-N] SIGINT semantics cancel the whole run and await backend settlement', async () => {
    const gate = new Gate();
    const transport = runtime(() => gate.wait());
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_start',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    if (!runId) throw new Error('expected run');
    await waitForProjection(transport, runId, (p) => Object.keys(p.modelCalls).length > 0);
    const controller = new AbortController();
    const done = watchRun(transport, runId, {
      write() {},
      signal: controller.signal,
      commandId: () => 'cmd_cancel',
    });
    controller.abort();
    await waitForProjection(transport, runId, (p) => p.status === 'cancelling');
    gate.open();
    expect((await done).status).toBe('cancelled');
  });

  it('[TC-DEC-001-N] judge status reports where the model is and whether it is installed, without downloading', async () => {
    const dir = workspace();
    const output: string[] = [];
    const io = {
      cwd: dir,
      write: (line: string) => output.push(line),
      signal: new AbortController().signal,
    };
    expect(await runCli(['judge', 'status', '--model-dir', dir], io)).toBe(0);
    expect(output.join('\n')).toContain('not installed');
    expect(output.join('\n')).toContain(dir);
    writeFileSync(join(dir, 'install.json'), JSON.stringify({ release: 'effort-judge-v6' }));
    output.length = 0;
    expect(await runCli(['judge', 'status', '--model-dir', dir], io)).toBe(0);
    expect(output.join('\n')).toContain('effort-judge-v6 installed');
    expect(await runCli(['judge', 'remove'], io)).toBe(1);
  });
});
