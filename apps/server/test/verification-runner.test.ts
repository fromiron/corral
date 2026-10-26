import { execFileSync, type spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@corral/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerificationRunner } from '../src/files/verification.ts';
import { spawnOwnedProcess } from '../src/processes/owned-process.ts';
import { systemTimers } from '../src/runtime.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(script: string) {
  const directory = mkdtempSync(join(tmpdir(), 'corral-check-'));
  dirs.push(directory);
  const root = join(directory, 'repo');
  execFileSync('git', ['init', '-q', root]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: root })
      .toString()
      .trim();
  writeFileSync(join(root, 'a.txt'), 'original');
  writeFileSync(join(root, 'check.mjs'), script);
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const clock = new FakeClock();
  return {
    root,
    clock,
    input: {
      verificationId: 'check_1',
      owner: {
        kind: 'execution' as const,
        runId: 'run_1',
        executionId: 'exec_1',
        attemptNo: 2,
        effectId: 'effect_1',
      },
      sessionId: 'session_1',
      sourceDirectory: root,
      copyRoot: join(directory, 'checks'),
      tree,
      configRevision: 1,
      fingerprint: 'a'.repeat(64),
      command: {
        id: 'check',
        name: 'Check',
        argv: [process.execPath, 'check.mjs'],
        timeoutMs: 20000,
      },
    },
  };
}
function cancellation() {
  const controller = new AbortController();
  return {
    cancel: () => controller.abort(),
    signal: {
      get aborted() {
        return controller.signal.aborted;
      },
      onCancel(fn: () => void) {
        controller.signal.addEventListener('abort', fn);
        return () => controller.signal.removeEventListener('abort', fn);
      },
    },
  };
}

describe('owned verification runner', { timeout: 25000 }, () => {
  it.skipIf(process.platform !== 'linux').each([false, true])(
    '[TC-SBX-001-N] namespace cleanup owns detached descendants (cancel=%s)',
    async (cancelled) => {
      const f = fixture(
        `import {spawn} from 'node:child_process'; spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref(); console.log('READY'); ${cancelled ? 'setInterval(()=>{},1000);' : ''}`,
      );
      const cancel = cancellation();
      const runner = new VerificationRunner({
        clock: f.clock,
        timers: systemTimers,
        spawn: (...args: Parameters<typeof spawn>) => {
          const child = (spawnOwnedProcess as typeof spawn)(...args);
          if (cancelled) child.stdout?.on('data', () => cancel.cancel());
          return child;
        },
      });
      const report = await runner.run({ ...f.input, isolation: 'linux-bwrap' }, cancel.signal);
      expect(report, report.output.text).toMatchObject({
        state: cancelled ? 'cancelled' : 'completed',
        verdict: cancelled ? 'not_evaluated' : 'pass',
        cleanupConfirmed: true,
      });
      expect(existsSync(join(f.input.copyRoot, f.input.verificationId))).toBe(false);
    },
  );
  it.skipIf(process.platform !== 'linux')(
    '[TC-SBX-001-N] sandbox exec failures are inconclusive even after the namespace started',
    async () => {
      const f = fixture('');
      const report = await new VerificationRunner({ clock: f.clock, timers: systemTimers }).run(
        {
          ...f.input,
          isolation: 'linux-bwrap',
          beforeLaunch: async (directory) => join(directory, 'a.txt'),
        },
        cancellation().signal,
      );
      expect(report).toMatchObject({
        state: 'error',
        verdict: 'inconclusive',
        cleanupConfirmed: true,
      });
      expect(report.isolation).toBeUndefined();
    },
  );
  it.skipIf(process.platform !== 'linux')(
    '[TC-SBX-001-N] isolated snapshot checkout and status never execute repository filters on the host',
    async () => {
      const f = fixture(
        "import fs from 'node:fs'; if(fs.readFileSync('a.txt','utf8') !== 'original') process.exit(1);",
      );
      const marker = join(f.root, '..', 'filter-ran');
      writeFileSync(join(f.root, '.gitattributes'), '*.txt filter=probe\n');
      execFileSync('git', ['add', '.'], { cwd: f.root });
      f.input.tree = execFileSync('git', ['write-tree'], { cwd: f.root }).toString().trim();
      for (const name of ['clean', 'smudge'])
        execFileSync('git', ['config', `filter.probe.${name}`, `tee '${marker}'`], { cwd: f.root });
      const report = await new VerificationRunner({ clock: f.clock, timers: systemTimers }).run(
        { ...f.input, isolation: 'linux-bwrap' },
        cancellation().signal,
      );
      expect(existsSync(marker)).toBe(false);
      expect(report, report.output.text).toMatchObject({ verdict: 'pass', targetUnchanged: true });
    },
  );
  it('[TC-SBX-001-N] exit zero without sandbox attestation is inconclusive', async () => {
    const f = fixture('');
    const report = await new VerificationRunner({
      clock: f.clock,
      timers: systemTimers,
      spawn: ((_exe, _args, options) =>
        spawnOwnedProcess(process.execPath, ['-e', ''], options)) as typeof spawn,
    }).run({ ...f.input, isolation: 'linux-bwrap' }, cancellation().signal);
    expect(report).toMatchObject({ state: 'error', verdict: 'inconclusive' });
    expect(report.isolation).toBeUndefined();
  });
  it.skipIf(process.platform !== 'linux')(
    '[TC-SBX-001-N] isolated checks cannot read the host, Git administration or inherited secrets',
    async () => {
      const f = fixture('');
      vi.stubEnv('CORRAL_CHECK_SECRET', 'fixture-secret');
      const privateFile = join(f.input.copyRoot, '..', 'private.txt');
      writeFileSync(privateFile, 'host-only');
      writeFileSync(
        join(f.root, 'check.mjs'),
        `
      import assert from 'node:assert/strict';
      import {execFileSync} from 'node:child_process';
      import fs from 'node:fs';
      import os from 'node:os';
      assert.equal(fs.existsSync(${JSON.stringify(privateFile)}), false);
      assert.equal(fs.existsSync(${JSON.stringify(join(f.root, '.git'))}), false);
      try { assert.equal(fs.readFileSync('.git', 'utf8'), ''); } catch (error) { assert.equal(error.code, 'EACCES'); }
      assert.equal(process.env.CORRAL_CHECK_SECRET, undefined);
      assert.equal(execFileSync('node', ['-p', 'process.version'], {encoding:'utf8'}).trim(), process.version);
      assert.ok(Object.values(os.networkInterfaces()).flat().every((nic) => nic.internal));
      console.log('isolated fixture passed');
    `,
      );
      execFileSync('git', ['add', '.'], { cwd: f.root });
      f.input.tree = execFileSync('git', ['write-tree'], { cwd: f.root }).toString().trim();
      const report = await new VerificationRunner({ clock: f.clock, timers: systemTimers }).run(
        { ...f.input, isolation: 'linux-bwrap' },
        cancellation().signal,
      );
      expect(report, report.output.text).toMatchObject({
        state: 'completed',
        verdict: 'pass',
        isolation: 'linux-bwrap',
        cleanupConfirmed: true,
        targetUnchanged: true,
      });
      expect(report.output.text).toContain('isolated fixture passed');
      expect(readFileSync(privateFile, 'utf8')).toBe('host-only');
    },
  );
  it('[TC-SBX-001-N] a failed sandbox launch never falls back to the registered host command', async () => {
    const f = fixture('');
    const launched: string[] = [];
    const report = await new VerificationRunner({
      clock: f.clock,
      timers: systemTimers,
      spawn: ((executable: string) => {
        launched.push(executable);
        throw new Error('sandbox unavailable');
      }) as typeof spawn,
    }).run({ ...f.input, isolation: 'linux-bwrap' }, cancellation().signal);
    expect(report).toMatchObject({ state: 'error', verdict: 'inconclusive' });
    expect(launched).toEqual(process.platform === 'linux' ? ['/usr/bin/bwrap'] : []);
  });
  it('[TC-HAR-013-N] a check that changes its own candidate cannot establish a pass', async () => {
    const f = fixture(
      "import fs from 'node:fs'; fs.writeFileSync('a.txt','changed during verification');",
    );
    const report = await new VerificationRunner({ clock: f.clock, timers: systemTimers }).run(
      f.input,
      cancellation().signal,
    );
    expect(report).toMatchObject({
      state: 'completed',
      verdict: 'inconclusive',
      targetUnchanged: false,
    });
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('original');
  });
  it('[TC-HAR-012-N] a cancelled duplicate cannot remove a directory owned by a different invocation', async () => {
    const f = fixture('');
    const existing = join(f.input.copyRoot, f.input.verificationId);
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'keep.txt'), 'keep');
    const cancel = cancellation();
    cancel.cancel();
    await new VerificationRunner({ clock: f.clock, timers: systemTimers }).run(
      f.input,
      cancel.signal,
    );
    expect(readFileSync(join(existing, 'keep.txt'), 'utf8')).toBe('keep');
  });
  it('[TC-HAR-012-H] executes the captured tree in a separate copy, preserving owner and injected duration', async () => {
    const f = fixture(`import fs from 'node:fs'; console.log(fs.readFileSync('a.txt','utf8'));`);
    writeFileSync(join(f.root, 'a.txt'), 'changed after capture');
    const updates: string[] = [];
    const runner = new VerificationRunner({
      clock: f.clock,
      timers: systemTimers,
      spawn: (...args: Parameters<typeof spawn>) => {
        f.clock.advance(250.75);
        return (spawnOwnedProcess as typeof spawn)(...args);
      },
    });
    const report = await runner.run(f.input, cancellation().signal, (r) => updates.push(r.state));
    expect(report).toMatchObject({
      owner: f.input.owner,
      tree: f.input.tree,
      state: 'completed',
      verdict: 'pass',
      exitCode: 0,
      durationMs: 251,
      cleanupConfirmed: true,
    });
    expect(report.output.text).toContain('original');
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('changed after capture');
    expect(updates).toEqual(['queued', 'running', 'completed']);
    expect(existsSync(join(f.input.copyRoot, f.input.verificationId))).toBe(false);
  });

  it('[TC-HAR-013-N] spawn failure is recorded once and never becomes an ordinary failed check', async () => {
    const f = fixture('');
    f.input.command.argv = ['/nonexistent/corral-test-command'];
    const updates: string[] = [];
    const report = await new VerificationRunner({ clock: f.clock, timers: systemTimers }).run(
      f.input,
      cancellation().signal,
      (r) => updates.push(r.state),
    );
    expect(report).toMatchObject({
      state: 'error',
      verdict: 'inconclusive',
      cleanupConfirmed: true,
    });
    expect(updates.filter((s) => s === 'error')).toHaveLength(1);
    expect(report.output.text).not.toContain('/nonexistent');
  });

  it('[TC-HAR-012-N] cancellation stops the process group, closes once and never reports a pass', async () => {
    const f = fixture(
      `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'], {stdio:'ignore'}); console.log('READY:'+child.pid); setInterval(()=>{},1000);`,
    );
    const cancel = cancellation();
    let descendant = 0;
    const runner = new VerificationRunner({
      clock: f.clock,
      timers: systemTimers,
      spawn: (...args: Parameters<typeof spawn>) => {
        const child = (spawnOwnedProcess as typeof spawn)(...args);
        child.stdout?.on('data', (chunk) => {
          const match = /READY:(\d+)/.exec(String(chunk));
          if (match) {
            descendant = Number(match[1]);
            cancel.cancel();
          }
        });
        return child;
      },
    });
    const report = await runner.run(f.input, cancel.signal);
    expect(descendant).toBeGreaterThan(0);
    expect(report).toMatchObject({ state: 'cancelled', verdict: 'not_evaluated' });
    expect(report.cleanupConfirmed).toBe(true);
    if (process.platform === 'win32') {
      expect(() => process.kill(descendant, 0)).toThrow();
    }
    // A killed orphan may remain as a zombie until init reaps it; it cannot keep writing.
    const state = (() => {
      try {
        return readFileSync(`/proc/${descendant}/stat`, 'utf8').split(' ')[2];
      } catch {
        return 'gone';
      }
    })();
    expect(['gone', 'Z']).toContain(state);
  });

  it('[TC-HAR-013-N] times out with an inconclusive verdict and skips an already cancelled invocation', async () => {
    const f = fixture('setInterval(()=>{},1000);');
    f.input.command.timeoutMs = 1000;
    const runner = new VerificationRunner({ clock: f.clock, timers: systemTimers });
    expect(await runner.run(f.input, cancellation().signal)).toMatchObject({
      state: 'error',
      verdict: 'inconclusive',
      timedOut: true,
      cleanupConfirmed: true,
    });
    const cancel = cancellation();
    cancel.cancel();
    expect(
      await runner.run({ ...f.input, verificationId: 'check_2' }, cancel.signal),
    ).toMatchObject({ state: 'cancelled', verdict: 'not_evaluated' });
    expect(existsSync(join(f.input.copyRoot, 'check_2'))).toBe(false);
  });

  it('[TC-HAR-013-N] bounds and redacts fragmented output without losing the head and tail', async () => {
    const f = fixture(
      `process.stdout.write('first\\nAuthorization: Bear'); setTimeout(()=> {process.stdout.write('er sk-sensitivecredential1234\\n'+process.cwd()+'\\n'+'x'.repeat(200000)+'\\nlast\\n');},20);`,
    );
    const report = await new VerificationRunner({ clock: f.clock, timers: systemTimers }).run(
      f.input,
      cancellation().signal,
    );
    expect(report.output.text).toContain('first');
    expect(report.output.text).toContain('last');
    expect(report.output.text).not.toContain('sensitivecredential');
    expect(report.output.text).not.toContain(f.input.copyRoot);
    expect(report.output.bytes).toBeGreaterThan(200000);
    expect(report.output.truncated).toBe(true);
    expect(Buffer.byteLength(report.output.text)).toBeLessThanOrEqual(65536);
    expect(report.output.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
