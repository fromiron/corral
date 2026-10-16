import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Coordinator, InProcessTransport, waitForProjection } from '@corral/core';
import { startCorralServer } from '@corral/server';
import { openReadOnlyDatabase, SqliteRunStore } from '@corral/storage-sqlite';
import {
  collaborationCorral,
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

describe('judgments in inspect (C-071)', () => {
  it('[TC-DEC-004-H] inspect --judgments lists each request with its provider and level', async () => {
    const cwd = workspace();
    mkdirSync(join(cwd, '.corral'), { recursive: true });
    writeFileSync(
      join(cwd, '.corral', 'config.json'),
      JSON.stringify({
        schemaVersion: '0.1',
        decisions: { reasoning_effort: { mode: 'observe', providers: ['local-heuristic'] } },
      }),
    );
    const path = join(cwd, 'workflow.json');
    writeFileSync(path, JSON.stringify(linearCorral(['writer'])));
    const output: string[] = [];
    const io = {
      cwd,
      write: (line: string) => output.push(line),
      signal: new AbortController().signal,
    };
    expect(await runCli(['run', path, '--demo', '--port', '0'], io)).toBe(0);
    const db = openReadOnlyDatabase(join(cwd, '.corral', 'corral.db'));
    const run = new SqliteRunStore(db).listRuns()[0];
    db.close();
    if (!run) throw new Error('expected recorded run');
    output.length = 0;
    expect(await runCli(['inspect', run.runId, '--judgments'], io)).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('observe only, not applied');
    expect(text).toMatch(/call_\S+ .*local-heuristic@1 medium/);
  });
});

describe('headless exec and eval (roadmap Core-③)', () => {
  const io = (cwd: string, output: string[]) => ({
    cwd,
    write: (line: string) => output.push(line),
    signal: new AbortController().signal,
  });

  it('[TC-DX-001-H] exec runs one Corral without Studio and reports the result as JSON', async () => {
    const cwd = workspace();
    const path = join(cwd, 'one.corral.json');
    writeFileSync(path, JSON.stringify(linearCorral(['writer'])));
    const output: string[] = [];
    expect(await runCli(['exec', path, '--demo', '--json'], io(cwd, output))).toBe(0);
    expect(output.some((line) => line.includes('Building Studio'))).toBe(false);
    const result = JSON.parse(output.at(-1) ?? '{}');
    expect(result).toMatchObject({ status: 'succeeded', needsUser: false });
    expect(result.output).toContain('writer');
    expect(result.modelCalls).toBe(2);
    expect(result.executions).toBe(1);
    expect(typeof result.wallMs).toBe('number');
  });

  it('[TC-DX-001-N] exec never approves for a person: a run that needs a decision is cancelled with exit 3', async () => {
    const cwd = workspace();
    const definition = linearCorral(['writer']);
    const output = definition.nodes.find((n) => n.type === 'output');
    if (output?.type === 'output') output.requireApproval = true;
    const path = join(cwd, 'approval.corral.json');
    writeFileSync(path, JSON.stringify(definition));
    const lines: string[] = [];
    expect(await runCli(['exec', path, '--demo'], io(cwd, lines))).toBe(3);
    expect(lines.join('\n')).toContain('needs a person');
    const db = openReadOnlyDatabase(join(cwd, '.corral', 'corral.db'));
    const run = new SqliteRunStore(db).listRuns()[0];
    db.close();
    expect(run?.status).toBe('cancelled');
  });

  it('[TC-DX-001-H] eval runs every variant on every brief and summarises calls, tokens and time', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'single.corral.json'), JSON.stringify(linearCorral(['writer'])));
    writeFileSync(join(cwd, 'team.corral.json'), JSON.stringify(collaborationCorral()));
    writeFileSync(
      join(cwd, 'suite.json'),
      JSON.stringify({
        schemaVersion: '0.1',
        briefs: [
          { id: 'compare', brief: 'Compare two databases.' },
          { id: 'explain', brief: 'Explain a cache.' },
        ],
        variants: [
          { id: 'single', corral: 'single.corral.json' },
          { id: 'team', corral: 'team.corral.json' },
        ],
      }),
    );
    const lines: string[] = [];
    expect(
      await runCli(['eval', 'suite.json', '--demo', '--out', 'report.json'], io(cwd, lines)),
    ).toBe(0);
    const report = JSON.parse(readFileSync(join(cwd, 'report.json'), 'utf8'));
    expect(report.results).toHaveLength(4);
    expect(
      report.results.map((r: { variant: string; brief: string }) => `${r.variant}:${r.brief}`),
    ).toEqual(['single:compare', 'team:compare', 'single:explain', 'team:explain']);
    const team = report.summary.find((s: { variant: string }) => s.variant === 'team');
    const single = report.summary.find((s: { variant: string }) => s.variant === 'single');
    expect(team.succeeded).toBe(2);
    expect(team.meanModelCalls).toBeGreaterThan(single.meanModelCalls);
    expect(lines.join('\n')).toMatch(/\| single \|/);
    expect(lines.join('\n')).toMatch(/\| team \|/);
  });

  it('[TC-DX-001-N] an invalid suite is refused before any run starts', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'single.corral.json'), JSON.stringify(linearCorral(['writer'])));
    writeFileSync(
      join(cwd, 'suite.json'),
      JSON.stringify({
        schemaVersion: '0.1',
        briefs: [{ id: 'a', brief: 'x' }],
        variants: [
          { id: 'v', corral: 'single.corral.json' },
          { id: 'v', corral: 'missing.corral.json' },
        ],
      }),
    );
    const lines: string[] = [];
    expect(await runCli(['eval', 'suite.json', '--demo'], io(cwd, lines))).toBe(1);
    expect(lines.join('\n')).toMatch(/duplicate variant id v|missing\.corral\.json/);
    expect(existsSync(join(cwd, '.corral', 'corral.db'))).toBe(false);
  });
});
