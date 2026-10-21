import type { ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type Clock,
  Identifier,
  RegisteredCheck,
  type Scheduler,
  VerificationOwner,
  VerificationReport,
} from '@corral/contracts';
import type { ToolCancellation } from '@corral/core';
import { HostProcessCapacityError, spawnOwnedProcess } from '../processes/owned-process.ts';
import { checkNamespaceGone, isolatedCheckLaunch } from './check-isolation.ts';
import { CheckOutput } from './check-output.ts';
import { checkGitEnvironment, git, gitText } from './git.ts';
import { killProcessGroup, processGroupGone } from './process-group.ts';

export interface VerificationInput {
  isolation?: 'linux-bwrap';
  verificationId: string;
  owner: VerificationOwner;
  sessionId: string;
  sourceDirectory: string;
  copyRoot: string;
  tree: string;
  configRevision: number;
  fingerprint: string;
  command: RegisteredCheck;
  /** Recheck launch identity/trust against the frozen copy immediately before spawning. */
  beforeLaunch?: (directory: string) => Promise<string | undefined>;
}

/** One check owns its immutable Git copy and child process group until cleanup completes. */
export class VerificationRunner {
  private readonly clock: Clock;
  private readonly timers: Scheduler;
  private readonly spawn: (...args: Parameters<typeof spawn>) => ChildProcess;
  constructor(options: {
    clock: Clock;
    timers: Scheduler;
    spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
  }) {
    this.clock = options.clock;
    this.timers = options.timers;
    this.spawn = options.spawn ?? (spawnOwnedProcess as typeof spawn);
  }

  async run(
    input: VerificationInput,
    cancellation: ToolCancellation,
    update: (report: VerificationReport) => void = () => {},
  ): Promise<VerificationReport> {
    const command = RegisteredCheck.parse(input.command);
    const id = Identifier.parse(input.verificationId);
    const start = this.clock.monotonicMs();
    const directory = join(resolve(input.copyRoot), id);
    let home: string | undefined;
    const output = new CheckOutput([directory, input.sourceDirectory, input.copyRoot]);
    const startedAt = this.clock.nowIso();
    let report = VerificationReport.parse({
      verificationId: id,
      owner: VerificationOwner.parse(input.owner),
      sessionId: input.sessionId,
      commandId: command.id,
      configRevision: input.configRevision,
      fingerprint: input.fingerprint,
      tree: input.tree,
      state: 'queued',
      verdict: 'not_evaluated',
      exitCode: null,
      signal: null,
      timedOut: false,
      cleanupConfirmed: false,
      durationMs: 0,
      startedAt,
      endedAt: null,
      retainUntil: new Date(Date.parse(startedAt) + 7 * 86400000).toISOString(),
      output: { text: '', bytes: 0, hash: '0'.repeat(64), truncated: false },
    });
    update(report);
    let checkEnv: Record<string, string> = {};
    let sandboxPid: number | undefined;
    let sandboxNamespace: number | undefined;
    let sandboxExit: number | undefined;
    let copied = false;
    let processClosed = true;
    let groupGone = true;
    let executable = command.argv[0] as string;
    try {
      if (!cancellation.aborted) {
        if (input.isolation) checkEnv = await checkGitEnvironment(input.sourceDirectory);
        await mkdir(input.copyRoot, { recursive: true, mode: 0o700 });
        const commit = await gitText(
          input.sourceDirectory,
          ['commit-tree', report.tree, '-m', 'Corral verification snapshot'],
          {
            ...checkEnv,
            GIT_AUTHOR_NAME: 'Corral',
            GIT_AUTHOR_EMAIL: 'corral@localhost',
            GIT_COMMITTER_NAME: 'Corral',
            GIT_COMMITTER_EMAIL: 'corral@localhost',
            GIT_AUTHOR_DATE: startedAt,
            GIT_COMMITTER_DATE: startedAt,
          },
        );
        if (!cancellation.aborted) {
          await git(input.sourceDirectory, ['worktree', 'add', '--detach', directory, commit], {
            env: checkEnv,
          });
          copied = true;
          home = await mkdtemp(join(input.copyRoot, `${id}-home-`));
          executable = (await input.beforeLaunch?.(directory)) ?? executable;
        }
      }
      if (cancellation.aborted) report = { ...report, state: 'cancelled' };
      else {
        const launch = input.isolation
          ? await isolatedCheckLaunch(directory, executable, command.argv.slice(1))
          : { executable, args: command.argv.slice(1) };
        report = { ...report, state: 'running' };
        update(report);
        const outcome = await new Promise<{
          code: number | null;
          signal: string | null;
          failed: boolean;
          cancelled: boolean;
          timedOut: boolean;
          closed: boolean;
          pid?: number;
        }>((resolveOutcome) => {
          let child: ChildProcess | undefined;
          let failed = false,
            cancelled = false,
            timedOut = false,
            finished = false;
          let cancelDeadline = () => {};
          let cancelCleanup = () => {};
          let off = () => {};
          const kill = () => {
            if (child) killProcessGroup(child);
          };
          const finish = (code: number | null, signal: string | null, closed: boolean) => {
            if (finished) return;
            finished = true;
            cancelDeadline();
            cancelCleanup();
            off();
            kill();
            resolveOutcome({
              code,
              signal,
              failed,
              cancelled,
              timedOut,
              closed,
              ...(child?.pid ? { pid: child.pid } : {}),
            });
          };
          const stop = (timeout: boolean) => {
            if (finished) return;
            if (timeout) timedOut = true;
            else cancelled = true;
            kill();
            cancelCleanup();
            cancelCleanup = this.timers.after(8000, () => finish(null, null, false));
          };
          try {
            child = this.spawn(launch.executable, launch.args, {
              cwd: directory,
              shell: false,
              detached: process.platform !== 'win32',
              stdio: input.isolation
                ? ['ignore', 'pipe', 'pipe', 'pipe']
                : ['ignore', 'pipe', 'pipe'],
              env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: home,
                XDG_CONFIG_HOME: home,
                LANG: 'C.UTF-8',
                CI: '1',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_TERMINAL_PROMPT: '0',
                NPM_CONFIG_USERCONFIG: join(home as string, 'npmrc'),
                NPM_CONFIG_GLOBALCONFIG: join(home as string, 'global-npmrc'),
              },
            });
            if (input.isolation) {
              let info = '';
              child.stdio[3]?.on('data', (chunk: Buffer) => {
                info = (info + chunk.toString()).slice(0, 4096);
                while (info.includes('\n')) {
                  const newline = info.indexOf('\n');
                  const line = info.slice(0, newline);
                  info = info.slice(newline + 1);
                  try {
                    const value = JSON.parse(line);
                    if (
                      Number.isSafeInteger(value['child-pid']) &&
                      value['child-pid'] > 0 &&
                      Number.isSafeInteger(value['pid-namespace'])
                    ) {
                      sandboxPid = value['child-pid'];
                      sandboxNamespace = value['pid-namespace'];
                    }
                    if (
                      sandboxPid &&
                      Number.isSafeInteger(value['exit-code']) &&
                      value['exit-code'] >= 0 &&
                      value['exit-code'] < 128
                    ) {
                      sandboxExit = value['exit-code'];
                      report = { ...report, isolation: input.isolation };
                    }
                  } catch {
                    /* Missing terminal attestation cannot produce a usable check. */
                  }
                }
              });
            }
            child.stdout?.on('data', (chunk: Buffer) => output.add('stdout', chunk));
            child.stderr?.on('data', (chunk: Buffer) => output.add('stderr', chunk));
            child.once('error', () => {
              failed = true;
            });
            // Descendants can retain stdio after the leader exits; stop them before waiting for close.
            child.once('exit', kill);
            child.once('close', (code, signal) => finish(code, signal, true));
            off = cancellation.onCancel(() => stop(false));
            cancelDeadline = this.timers.after(command.timeoutMs, () => stop(true));
            if (cancellation.aborted) stop(false);
          } catch (error) {
            failed = true;
            if (error instanceof HostProcessCapacityError)
              output.add('stderr', Buffer.from(error.message));
            finish(null, null, true);
          }
        });
        processClosed = outcome.closed;
        groupGone = !outcome.pid || (await processGroupGone(outcome.pid, this.timers));
        if (input.isolation && outcome.pid)
          groupGone =
            groupGone &&
            !!sandboxPid &&
            sandboxNamespace !== undefined &&
            (await checkNamespaceGone(sandboxPid, sandboxNamespace, this.timers));
        const cancelled = outcome.cancelled || cancellation.aborted;
        const error =
          outcome.failed ||
          outcome.timedOut ||
          !processClosed ||
          !groupGone ||
          (input.isolation !== undefined &&
            (report.isolation !== input.isolation || sandboxExit !== outcome.code)) ||
          outcome.signal !== null;
        report = {
          ...report,
          state: cancelled ? 'cancelled' : error ? 'error' : 'completed',
          verdict: cancelled
            ? 'not_evaluated'
            : error
              ? 'inconclusive'
              : outcome.code === 0
                ? 'pass'
                : 'fail',
          exitCode: outcome.code,
          signal: outcome.signal,
          timedOut: outcome.timedOut,
        };
        if (processClosed && groupGone && report.state === 'completed') {
          const targetUnchanged =
            (await gitText(
              directory,
              ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
              checkEnv,
            )) === '';
          report = {
            ...report,
            targetUnchanged,
            verdict: targetUnchanged ? report.verdict : 'inconclusive',
          };
        }
      }
    } catch {
      report = {
        ...report,
        state: cancellation.aborted ? 'cancelled' : 'error',
        verdict: cancellation.aborted ? 'not_evaluated' : 'inconclusive',
      };
    } finally {
      if (processClosed && groupGone) {
        try {
          if (copied)
            await git(input.sourceDirectory, ['worktree', 'remove', '--force', directory], {
              env: checkEnv,
            });
          if (home) await rm(home, { recursive: true, force: true });
          report = { ...report, cleanupConfirmed: true };
        } catch {
          report = {
            ...report,
            state: report.state === 'cancelled' ? 'cancelled' : 'error',
            verdict: report.state === 'cancelled' ? 'not_evaluated' : 'inconclusive',
          };
        }
      }
    }
    report = {
      ...report,
      durationMs: Math.max(0, Math.round(this.clock.monotonicMs() - start)),
      endedAt: this.clock.nowIso(),
      output: output.finish(),
    };
    update(report);
    return report;
  }
}
