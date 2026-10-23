import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalView } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { expect, it } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

it.skipIf(process.platform !== 'linux')(
  '[TC-WBD-004-H] actual terminal writes only its managed copy and shares writer and fixed-reader ownership',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'corral-pty-workspace-'));
    const original = join(root, 'original');
    execFileSync('git', ['init', '-q', original]);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
        cwd: original,
      });
    writeFileSync(join(original, 'a.txt'), 'before\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    const db = openDatabase(':memory:');
    db.exec(
      "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('session','default',NULL,'t','',0,1,'x','x','[]'); INSERT INTO runs(id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id) VALUES('reader','c','h','{}','running',0,'{}','x','default','session');",
    );
    const service = new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
      hostId: 'fixture-host',
    });
    let closeStream = () => {};
    try {
      await service.bind('default', original);
      await service.configure('default', { trusted: true });
      await service.createWorktree('session', 'default');
      const document = await service.readDocument('session', 'a.txt');
      const create = {
        operationId: 'terminal_fixture',
        target: document.target,
        shellId: 'bash',
        cols: 80,
        rows: 24,
      };
      await expect(
        service.terminals.create('session', {
          ...create,
          target: { ...document.target, hostId: 'other-host' },
        }),
      ).rejects.toThrow(/target/);
      const terminal = await service.terminals.create('session', create);
      let output = '';
      let latest: TerminalView = terminal;
      let changed = () => {};
      const stream = service.terminals.subscribe(
        'session',
        terminal.terminalId,
        { generation: terminal.generation, afterSeq: 0 },
        (event) => {
          if (event.type === 'output') output += event.data;
          if (event.type === 'status') latest = event.terminal;
          changed();
        },
      );
      closeStream = stream.close;
      const until = (predicate: () => boolean) =>
        new Promise<void>((resolve, reject) => {
          const watchdog = setTimeout(
            () => reject(new Error('terminal fixture did not report completion')),
            15000,
          );
          changed = () => {
            if (predicate()) {
              clearTimeout(watchdog);
              resolve();
            }
          };
          changed();
        });
      await until(
        () =>
          latest.state === 'running' || latest.state === 'failed' || latest.state === 'uncertain',
      );
      expect(latest.state).toBe('running');
      expect(() => service.acquireRun('writer', 'session', true)).toThrow(/writer/);
      await expect(
        service.changeDocument('session', {
          kind: 'save',
          operationId: 'save_conflict',
          target: document.target,
          path: 'a.txt',
          baseHash: document.version?.sha256 ?? null,
          editVersion: 1,
          text: 'blocked\n',
        }),
      ).rejects.toThrow(/writer/);
      service.acquireRun('reader', 'session', false);
      await service.prepareRun('reader');
      const identity = { target: document.target, generation: terminal.generation };
      const controller = service.terminals.control('session', terminal.terminalId, {
        ...identity,
        attachmentId: 'fixture_view',
        expectedGeneration: 0,
        action: 'claim',
        takeover: false,
      });
      service.terminals.input('session', terminal.terminalId, {
        ...identity,
        attachmentId: 'fixture_view',
        controllerGeneration: controller.controllerGeneration,
        sequence: 1,
        data: "stty -echo; printf 'after\\n' > a.txt; printf '\\nRESULT=%s\\n' ready\r",
      });
      await until(() => output.includes('\r\nRESULT=ready\r\n'));
      expect((await service.readDocument('session', 'a.txt')).content).toEqual({
        kind: 'text',
        text: 'after\n',
      });
      expect((await service.readPreviewSnapshot('reader', 'a.txt'))?.toString()).toBe('before\n');
      expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('before\n');
      expect((await service.terminals.stop('session', terminal.terminalId, identity)).state).toBe(
        'exited',
      );
      expect((await service.readDocument('session', 'a.txt')).writable).toBe(true);
      expect(service.terminals.get('session', terminal.terminalId).exitCode).not.toBeUndefined();
    } finally {
      closeStream();
      await service.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
