import type { ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scheduler } from '@corral/contracts';
import type { ToolCancellation } from '@corral/core';
import { CheckOutput } from '../files/check-output.ts';
import { killProcessGroup, processGroupGone } from '../files/process-group.ts';
import { attestProcessConnection } from './connection-owner.ts';
import {
  HostProcessCapacityError,
  ownedProcessStarted,
  spawnOwnedProcess,
} from './owned-process.ts';
import { commandEnvironment, type ShellCommand } from './shells.ts';

export type CommandOwner = {
  hostId: string;
  sessionId: string;
  runId: string;
  executionId: string;
  attemptNo: number;
  effectId: string;
};
/** A development task a person started (CR-046 P15); its receipt is a workbench operation. */
export type UserTaskOwner = {
  kind: 'user';
  hostId: string;
  sessionId: string;
  operationId: string;
};
export type OwnedCommandInput<Owner extends { sessionId: string } = CommandOwner> = {
  operationId: string;
  owner: Owner;
  /** Broker-resolved directory and shell, already pinned by the approved plan. */
  directory: string;
  command: Omit<ShellCommand, 'shellId'> & { shellId?: ShellCommand['shellId'] };
  timeoutMs?: number;
};
export type OwnedCommandReport = {
  operationId: string;
  state: 'completed' | 'failed' | 'cancelled' | 'uncertain';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cleanupConfirmed: boolean;
  output: ReturnType<CheckOutput['finish']>;
};
type Operation<Owner extends { sessionId: string }> = {
  started: Promise<boolean>;
  resolveStarted: (started: boolean) => void;
  child?: ChildProcess;
  input: OwnedCommandInput<Owner>;
  key: string;
  output: CheckOutput;
  completion: Promise<OwnedCommandReport>;
  stop: () => void;
  report?: OwnedCommandReport;
};

const timers: Scheduler = {
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

export class CommandCapacityError extends Error {
  readonly code = 'command_process_capacity';
  readonly limit: number;

  constructor(limit: number) {
    super(`Command process capacity reached (${limit} active processes)`);
    this.name = 'CommandCapacityError';
    this.limit = limit;
  }
}

/** Callers retain the worktree writer lease until completion AND confirmed cleanup. */
export class CommandRuntime<Owner extends { sessionId: string } = CommandOwner> {
  private readonly operations = new Map<string, Operation<Owner>>();
  private readonly maxActiveProcesses: number;
  private activeProcesses = 0;

  constructor(options: { maxActiveProcesses?: number } = {}) {
    this.maxActiveProcesses = options.maxActiveProcesses ?? 12;
    if (!Number.isSafeInteger(this.maxActiveProcesses) || this.maxActiveProcesses < 1)
      throw new Error('maxActiveProcesses must be a positive safe integer');
  }

  run(
    input: OwnedCommandInput<Owner>,
    cancellation: ToolCancellation,
  ): Promise<OwnedCommandReport> {
    return this.startService(input, cancellation).completion;
  }

  startService(input: OwnedCommandInput<Owner>, cancellation: ToolCancellation) {
    const key = JSON.stringify(input);
    const existing = this.operations.get(input.operationId);
    if (existing) {
      if (existing.key !== key)
        throw new Error('Operation identity was reused with different input');
      return {
        operationId: input.operationId,
        completion: existing.completion,
        started: existing.started,
      };
    }
    if (this.operations.size >= 4096) throw new Error('Command operation retention limit reached');
    if (this.activeProcesses >= this.maxActiveProcesses)
      throw new CommandCapacityError(this.maxActiveProcesses);
    let resolveStarted: (value: boolean) => void = () => {};
    const started = new Promise<boolean>((resolve) => {
      resolveStarted = resolve;
    });
    const operation: Operation<Owner> = {
      started,
      resolveStarted,
      input,
      key,
      output: new CheckOutput([input.directory]),
      completion: Promise.resolve(null as unknown as OwnedCommandReport),
      stop: () => {},
    };
    this.operations.set(input.operationId, operation);
    // Reserve before the first filesystem/spawn await; pending starts also consume capacity.
    this.activeProcesses += 1;
    operation.completion = this.execute(operation, cancellation).then((report) => {
      operation.report = report;
      // Uncertain termination must keep its reservation even after completion settles.
      if (report.cleanupConfirmed) this.activeProcesses -= 1;
      return report;
    });
    return {
      operationId: input.operationId,
      completion: operation.completion,
      started: operation.started,
    };
  }

  list(owner: { sessionId: string }) {
    return [...this.operations.values()]
      .filter((op) => op.input.owner.sessionId === owner.sessionId)
      .map((op) => ({
        operationId: op.input.operationId,
        owner: op.input.owner,
        state: op.report?.state ?? 'running',
        cleanupConfirmed: op.report?.cleanupConfirmed ?? false,
      }));
  }

  read(operationId: string, offset = 0, limit = 8192) {
    const operation = this.operations.get(operationId);
    if (!operation) return null;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid output offset');
    const output = operation.report?.output ?? operation.output.snapshot();
    const text = output.text.slice(offset, offset + Math.max(1, Math.min(8192, limit)));
    return {
      text,
      nextOffset: offset + text.length,
      bytes: output.bytes,
      truncated: output.truncated,
    };
  }

  /** The live process group leader, while the command runs. */
  pid(operationId: string): number | undefined {
    const operation = this.operations.get(operationId);
    return operation && !operation.report ? operation.child?.pid : undefined;
  }

  stop(operationId: string) {
    const operation = this.operations.get(operationId);
    operation?.stop();
    return operation?.completion ?? null;
  }

  /** A proxy must establish the socket first, then attest before sending request bytes. */
  attestConnection(operationId: string, port: number, peerPort: number) {
    const operation = this.operations.get(operationId);
    if (
      !operation ||
      operation.report ||
      !operation.child?.pid ||
      operation.child.exitCode !== null ||
      operation.child.signalCode !== null
    )
      return Promise.resolve(false);
    return attestProcessConnection(operation.child, port, peerPort);
  }

  async close() {
    await Promise.all(
      [...this.operations.values()].map((op) => {
        if (!op.report) op.stop();
        return op.completion;
      }),
    );
  }

  private async execute(
    operation: Operation<Owner>,
    cancellation: ToolCancellation,
  ): Promise<OwnedCommandReport> {
    const { input, output } = operation;
    let child: ChildProcess | undefined;
    let cancelled = cancellation.aborted;
    let timedOut = false;
    let home: string | undefined;
    let cleanupConfirmed = true;
    let failure = false;
    let off = () => {};
    let cancelDeadline = () => {};
    let cancelWatchdog = () => {};
    let finish:
      | ((outcome: { code: number | null; signal: string | null; closed: boolean }) => void)
      | undefined;
    operation.stop = () => {
      if (operation.report) return;
      cancelled = true;
      if (child) killProcessGroup(child);
      cancelWatchdog();
      cancelWatchdog = timers.after(8000, () =>
        finish?.({ code: null, signal: null, closed: false }),
      );
    };
    let outcome = { code: null as number | null, signal: null as string | null, closed: true };
    try {
      // Resolving before launch also rejects missing worktrees instead of silently changing cwd.
      const directory = await realpath(input.directory);
      home = await mkdtemp(join(tmpdir(), 'corral-command-'));
      off = cancellation.onCancel(operation.stop);
      if (!cancelled && !cancellation.aborted) {
        outcome = await new Promise((resolve) => {
          finish = resolve;
          child = spawnOwnedProcess(input.command.executable, input.command.args, {
            cwd: directory,
            env: commandEnvironment(home as string),
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          operation.child = child;
          void ownedProcessStarted(child).then(operation.resolveStarted);
          cleanupConfirmed = !child.pid;
          child.stdout?.on('data', (chunk: Buffer) => output.add('stdout', chunk));
          child.stderr?.on('data', (chunk: Buffer) => output.add('stderr', chunk));
          child.once('error', () => {
            failure = true;
          });
          child.once('exit', () => killProcessGroup(child as ChildProcess));
          child.once('close', (code, signal) => resolve({ code, signal, closed: true }));
          cancelDeadline = timers.after(
            Math.max(100, Math.min(input.timeoutMs ?? 120000, 3600000)),
            () => {
              timedOut = true;
              operation.stop();
            },
          );
          if (cancellation.aborted) operation.stop();
        });
        cleanupConfirmed =
          outcome.closed && (!child?.pid || (await processGroupGone(child.pid, timers)));
      } else cancelled = true;
    } catch (error) {
      failure = true;
      if (error instanceof HostProcessCapacityError)
        output.add('stderr', Buffer.from(error.message));
      if (child) {
        killProcessGroup(child);
        cleanupConfirmed = false;
      }
    } finally {
      operation.resolveStarted(false);
      off();
      cancelDeadline();
      cancelWatchdog();
      if (home && cleanupConfirmed) await rm(home, { recursive: true, force: true });
    }
    return {
      operationId: input.operationId,
      state: !cleanupConfirmed
        ? 'uncertain'
        : timedOut || failure
          ? 'failed'
          : cancelled
            ? 'cancelled'
            : 'completed',
      exitCode: outcome.code,
      signal: outcome.signal,
      timedOut,
      cleanupConfirmed,
      output: output.finish(),
    };
  }
}
