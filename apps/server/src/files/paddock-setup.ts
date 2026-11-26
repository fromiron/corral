import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  type HostProcessReservation,
  restoreHostProcessGroupReservation,
} from '@corral/adapter-pi/processes';
import { type Clock, canonicalJson, type WorkspaceTarget } from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import { confirmOwnedProcessCleanup } from '../processes/owned-process.ts';
import {
  capturePtySession,
  cleanupPtySession,
  type PtySessionIdentity,
} from '../processes/pty-session.ts';
import type { CommandRuntime, OwnedCommandReport, UserTaskOwner } from '../processes/runtime.ts';
import { resolveShellCommand } from '../processes/shells.ts';
import type { WorkbenchOperation, WorkbenchOperations } from './workbench-operations.ts';
import { WorkspaceAccessStore } from './workspace-access.ts';

export type SetupReason =
  | 'command_failed'
  | 'command_timeout'
  | 'launch_failed'
  | 'stopped'
  | 'trust_revoked'
  | 'interrupted'
  | 'interrupted_unconfirmed';
export interface SetupSummary {
  operationId: string;
  state: WorkbenchOperation['state'];
  reason: SetupReason | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}
export interface SetupDetail extends SetupSummary {
  target: WorkspaceTarget;
  output: { text: string; truncated: boolean };
}

export interface SetupCopy {
  path: string;
  target: WorkspaceTarget;
  sourceDir: string;
  command: string | null;
  trusted: boolean;
}

interface Stored {
  commandHash: string;
  reason: SetupReason | null;
  exitCode: number | null;
  cleanupConfirmed: boolean;
  pid?: number;
  processIdentity?: PtySessionIdentity;
  stopReason?: 'stopped' | 'trust_revoked';
  output?: { text: string; truncated: boolean };
  endedAt?: string;
}

export interface SetupOptions {
  environment?: () => NodeJS.ProcessEnv;
  timeoutMs?: number;
  identity?: (pid: number, owner: string) => PtySessionIdentity;
  ended?: (sessionId: string) => void;
}

const SETUP_TIMEOUT_MS = 30 * 60_000;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const noCancel = { aborted: false, onCancel: () => () => {} };
const PASSED = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'SSH_AUTH_SOCK',
];

export function setupEnvironment(
  host: NodeJS.ProcessEnv,
  sourceDir: string,
  operationId: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of PASSED) {
    const value = host[key];
    if (value !== undefined) environment[key] = value;
  }
  if (!environment.HOME && !environment.USERPROFILE) environment.HOME = homedir();
  return {
    ...environment,
    LANG: 'C.UTF-8',
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    CORRAL_PROCESS_OWNER: operationId,
    CORRAL_SOURCE_DIR: sourceDir,
  };
}

export class PaddockSetups {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly operations: WorkbenchOperations;
  private readonly access: WorkspaceAccessStore;
  private readonly runtime: CommandRuntime<UserTaskOwner>;
  private readonly hostId: string;
  private readonly copy: (sessionId: string) => SetupCopy | null;
  private readonly options: SetupOptions;
  private readonly recovered = new Map<string, HostProcessReservation>();

  constructor(input: {
    db: Db;
    clock: Clock;
    operations: WorkbenchOperations;
    runtime: CommandRuntime<UserTaskOwner>;
    hostId: string;
    shares: boolean;
    copy: (sessionId: string) => SetupCopy | null;
    options?: SetupOptions;
  }) {
    this.db = input.db;
    this.clock = input.clock;
    this.operations = input.operations;
    this.access = new WorkspaceAccessStore(input.db, input.shares);
    this.runtime = input.runtime;
    this.hostId = input.hostId;
    this.copy = input.copy;
    this.options = input.options ?? {};
    // The ledger has already turned an earlier host process's running setups uncertain.
    for (const receipt of this.operations.list('setup')) {
      if (receipt.state !== 'uncertain') continue;
      const stored = receipt.result as Stored;
      if (stored.cleanupConfirmed) continue;
      if (stored.processIdentity)
        this.recovered.set(receipt.operationId, restoreHostProcessGroupReservation());
      else
        this.operations.reconcile(receipt.operationId, ['setup'], 'failed', {
          ...stored,
          reason: 'interrupted_unconfirmed',
          endedAt: receipt.updatedAt,
        } satisfies Stored);
    }
  }

  private summary(receipt: WorkbenchOperation): SetupSummary {
    const stored = receipt.result as Stored;
    return {
      operationId: receipt.operationId,
      state: receipt.state,
      reason: stored.reason,
      exitCode: stored.exitCode,
      startedAt: receipt.createdAt,
      endedAt: receipt.state === 'running' ? null : (stored.endedAt ?? receipt.updatedAt),
    };
  }

  private receipt(sessionId: string, operationId: string): WorkbenchOperation {
    const receipt = this.operations.get(operationId);
    if (!receipt || receipt.kind !== 'setup' || receipt.target.sessionId !== sessionId)
      throw new ToolRefusal('TARGET_NOT_FOUND', 'the setup is unavailable');
    return receipt;
  }

  private settleGone(receipt: WorkbenchOperation): WorkbenchOperation {
    const stored = receipt.result as Stored;
    if (receipt.state !== 'uncertain' || !stored.processIdentity) return receipt;
    if (this.runtime.pid(receipt.operationId) !== undefined) return receipt;
    let alive = true;
    try {
      process.kill(-stored.processIdentity.pid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    if (alive) return receipt;
    this.release(receipt.operationId);
    return this.operations.reconcile(receipt.operationId, ['setup'], 'failed', {
      ...stored,
      reason: 'interrupted',
      cleanupConfirmed: true,
      endedAt: this.clock.nowIso(),
    } satisfies Stored);
  }

  private release(operationId: string) {
    this.recovered.get(operationId)?.releaseConfirmed();
    this.recovered.delete(operationId);
  }

  private receipts(sessionId: string, copyGeneration: number): WorkbenchOperation[] {
    const rows = this.db
      .prepare(
        "SELECT operation_id FROM workbench_operations WHERE kind='setup' AND json_extract(target_json,'$.sessionId')=? AND json_extract(target_json,'$.copyGeneration')=? ORDER BY rowid",
      )
      .all(sessionId, copyGeneration) as { operation_id: string }[];
    return rows.map((row) => this.operations.get(row.operation_id) as WorkbenchOperation);
  }

  latest(sessionId: string, copyGeneration: number): SetupSummary | null {
    const receipt = this.receipts(sessionId, copyGeneration).at(-1);
    return receipt ? this.summary(this.settleGone(receipt)) : null;
  }

  running(sessionId: string): boolean {
    const copy = this.copy(sessionId);
    return copy ? this.latest(sessionId, copy.target.copyGeneration)?.state === 'running' : false;
  }

  detail(sessionId: string, operationId: string): SetupDetail {
    const receipt = this.settleGone(this.receipt(sessionId, operationId));
    const stored = receipt.result as Stored;
    const live = this.runtime.read(operationId, 0, 32 * 1024);
    return {
      ...this.summary(receipt),
      target: receipt.target,
      output: live
        ? { text: live.text, truncated: live.truncated }
        : (stored.output ?? { text: '', truncated: false }),
    };
  }

  async startForNewCopy(sessionId: string): Promise<SetupSummary | null> {
    const copy = this.copy(sessionId);
    if (!copy?.command || !copy.trusted) return null;
    const operationId = `setup_${hash({
      sessionId,
      bindingId: copy.target.bindingId,
      copyGeneration: copy.target.copyGeneration,
    }).slice(0, 40)}`;
    return this.start(sessionId, { operationId, target: copy.target });
  }

  async start(
    sessionId: string,
    input: { operationId: string; target: WorkspaceTarget },
  ): Promise<SetupSummary> {
    const requestHash = hash(input);
    const prior = this.operations.get(input.operationId);
    if (prior) {
      if (prior.kind !== 'setup' || prior.requestHash !== requestHash)
        throw new ToolRefusal('REVISION_CONFLICT', 'operation request changed');
      return this.summary(prior);
    }
    const copy = this.copy(sessionId);
    if (!copy) throw new ToolRefusal('TARGET_NOT_FOUND', 'this session has no working copy');
    const { target } = copy;
    if (
      input.target.sessionId !== sessionId ||
      input.target.hostId !== target.hostId ||
      input.target.projectId !== target.projectId ||
      input.target.bindingId !== target.bindingId ||
      input.target.copyGeneration !== target.copyGeneration
    )
      throw new ToolRefusal('REVISION_CONFLICT', 'the working copy changed');
    if (!copy.command)
      throw new ToolRefusal('TARGET_NOT_FOUND', 'the project has no setup command');
    if (!copy.trusted)
      throw new ToolRefusal('CAPABILITY_DENIED', 'trust the repository before setting it up');
    const current = this.receipts(sessionId, target.copyGeneration)
      .map((item) => this.settleGone(item))
      .find((item) => item.state === 'running' || item.state === 'uncertain');
    if (current) {
      const access = this.access.get({ kind: 'user', id: current.operationId });
      throw new ToolRefusal(
        'RUN_ALREADY_ACTIVE',
        'this copy is being set up',
        access
          ? this.access.holder(access)
          : {
              kind: 'operation',
              id: current.operationId,
              sessionId,
              state: current.state === 'uncertain' ? 'uncertain' : 'active',
              operationKind: 'setup',
            },
      );
    }
    const command = copy.command;
    const stored: Stored = {
      commandHash: hash(command),
      reason: null,
      exitCode: null,
      cleanupConfirmed: false,
    };
    const admitted = this.operations.admit(
      { operationId: input.operationId, target: input.target, kind: 'setup', requestHash },
      copy.path,
      stored,
    );
    if (!admitted.admitted) return this.summary(admitted.receipt);
    try {
      await this.launch(sessionId, input.operationId, stored, copy, command);
    } catch {
      this.end(sessionId, input.operationId, 'failed', {
        ...stored,
        reason: 'launch_failed',
        cleanupConfirmed: true,
      });
    }
    return this.summary(this.receipt(sessionId, input.operationId));
  }

  private async launch(
    sessionId: string,
    operationId: string,
    stored: Stored,
    copy: SetupCopy,
    command: string,
  ) {
    const shell = await resolveShellCommand(command);
    const environment = setupEnvironment(
      this.options.environment?.() ?? process.env,
      copy.sourceDir,
      operationId,
    );
    const launched = this.runtime.startService(
      {
        operationId,
        owner: { kind: 'user', hostId: this.hostId, sessionId, operationId },
        directory: copy.path,
        command: { executable: shell.executable, args: shell.args, shellId: shell.shellId },
        timeoutMs: this.options.timeoutMs ?? SETUP_TIMEOUT_MS,
        environment,
        ownEnvironment: true,
        hiddenPaths: [copy.sourceDir, environment.HOME ?? '', environment.USERPROFILE ?? ''],
      },
      noCancel,
    );
    void launched.completion.then(
      (report) => this.completed(sessionId, operationId, report),
      () => this.end(sessionId, operationId, 'uncertain', { ...this.stored(operationId) }),
    );
    await launched.started;
    const pid = this.runtime.pid(operationId);
    if (!pid) return;
    const running: Stored = { ...stored, pid };
    try {
      if (this.options.identity) running.processIdentity = this.options.identity(pid, operationId);
      else if (process.platform === 'linux')
        running.processIdentity = capturePtySession(pid, operationId);
    } catch {
      // Without an identity a later host process cannot prove the end; it settles the setup.
    }
    this.operations.updateRunning(operationId, running);
  }

  private stored(operationId: string): Stored {
    return (this.operations.get(operationId)?.result ?? {}) as Stored;
  }

  private completed(sessionId: string, operationId: string, report: OwnedCommandReport) {
    const stored = this.stored(operationId);
    const reason: SetupReason | null = report.timedOut
      ? 'command_timeout'
      : report.state === 'cancelled'
        ? (stored.stopReason ?? 'stopped')
        : report.state === 'failed'
          ? 'launch_failed'
          : report.state === 'completed' && report.exitCode !== 0
            ? 'command_failed'
            : null;
    const state: Exclude<WorkbenchOperation['state'], 'running'> =
      report.state === 'uncertain'
        ? 'uncertain'
        : report.state === 'cancelled'
          ? 'cancelled'
          : reason
            ? 'failed'
            : 'succeeded';
    this.end(sessionId, operationId, state, {
      ...stored,
      reason: state === 'uncertain' ? null : reason,
      exitCode: report.exitCode,
      cleanupConfirmed: report.cleanupConfirmed,
      output: { text: report.output.text, truncated: report.output.truncated },
    });
  }

  private end(
    sessionId: string,
    operationId: string,
    state: Exclude<WorkbenchOperation['state'], 'running'>,
    stored: Stored,
  ) {
    const before = this.operations.get(operationId);
    const after = this.operations.finish(operationId, state, {
      ...stored,
      endedAt: this.clock.nowIso(),
    } satisfies Stored);
    if (before?.state !== 'running' || after.state === 'running') return;
    this.announce(sessionId, after);
  }

  private announce(sessionId: string, receipt: WorkbenchOperation) {
    if (receipt.state === 'uncertain') return;
    const copy = this.copy(sessionId);
    if (copy?.target.copyGeneration === receipt.target.copyGeneration)
      this.options.ended?.(sessionId);
  }

  async stop(sessionId: string, operationId: string, target: WorkspaceTarget) {
    const receipt = this.receipt(sessionId, operationId);
    if (canonicalJson(receipt.target) !== canonicalJson(target))
      throw new ToolRefusal('REVISION_CONFLICT', 'the setup belongs to another working copy');
    return this.halt(sessionId, receipt, 'stopped');
  }

  private async halt(
    sessionId: string,
    receipt: WorkbenchOperation,
    why: 'stopped' | 'trust_revoked',
  ): Promise<SetupSummary> {
    if (receipt.state !== 'running' && receipt.state !== 'uncertain') return this.summary(receipt);
    const stored = receipt.result as Stored;
    if (receipt.state === 'running')
      this.operations.updateRunning(receipt.operationId, { ...stored, stopReason: why });
    const live = this.runtime.stop(receipt.operationId);
    if (live) {
      await live;
      return this.summary(this.receipt(sessionId, receipt.operationId));
    }
    if (stored.processIdentity && (await cleanupPtySession(stored.processIdentity))) {
      confirmOwnedProcessCleanup(stored.processIdentity.pid);
      this.release(receipt.operationId);
      const settled = this.operations.reconcile(receipt.operationId, ['setup'], 'cancelled', {
        ...stored,
        reason: why,
        cleanupConfirmed: true,
        endedAt: this.clock.nowIso(),
      } satisfies Stored);
      this.announce(sessionId, settled);
      return this.summary(settled);
    }
    return this.summary(this.receipt(sessionId, receipt.operationId));
  }

  async revokeTrust(projectId: string) {
    await Promise.all(
      this.operations
        .list('setup')
        .filter((receipt) => receipt.target.projectId === projectId && receipt.state === 'running')
        .map((receipt) => this.halt(receipt.target.sessionId, receipt, 'trust_revoked')),
    );
  }

  dispose() {
    this.recovered.clear();
  }
}
