import { createHash } from 'node:crypto';
import {
  type HostProcessReservation,
  restoreHostProcessGroupReservation,
} from '@corral/adapter-pi/processes';
import {
  canonicalJson,
  DeploymentAction,
  DeploymentInspect,
  type DeploymentList,
  type DeploymentPlan,
  DeploymentReadback,
  DeploymentStart,
  type DeploymentView,
  type ProjectToolConfigRevision,
  type WorkspaceTarget,
} from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import { confirmOwnedProcessCleanup } from '../processes/owned-process.ts';
import {
  capturePtySession,
  cleanupPtySession,
  type PtySessionIdentity,
} from '../processes/pty-session.ts';
import type { CommandRuntime, OwnedCommandReport, UserTaskOwner } from '../processes/runtime.ts';
import { launchFingerprint } from './launch-fingerprint.ts';
import { readUserGitStatus } from './user-git.ts';
import type { WorkbenchOperations } from './workbench-operations.ts';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const noCancel = { aborted: false, onCancel: () => () => {} };
interface Stored
  extends Omit<DeploymentView, 'operationId' | 'target' | 'state' | 'createdAt' | 'updatedAt'> {
  activeId: string;
  attempt: number;
  processIdentity?: PtySessionIdentity;
  readbackFingerprint: string;
  environmentHash: string;
}
interface Options {
  db: Db;
  operations: WorkbenchOperations;
  runtime: CommandRuntime<UserTaskOwner>;
  resolveTarget(sessionId: string, target: WorkspaceTarget): string;
  config(projectId: string): ProjectToolConfigRevision | null | undefined;
  snapshot(root: string): Promise<string>;
  lease<T>(root: string, work: () => Promise<T>): Promise<T>;
  environment?(): NodeJS.ProcessEnv;
}

/** Deployment uses the task runtime and the human operation ledger; command exit is not publication evidence. */
export class DeploymentTasks {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly recovered = new Map<string, HostProcessReservation>();
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    for (const receipt of options.operations.list('deployment')) {
      if (receipt.state === 'uncertain' && (receipt.result as Stored)?.cleanupConfirmed !== true)
        this.recovered.set(receipt.operationId, restoreHostProcessGroupReservation());
    }
  }

  private environment(names: string[]) {
    const available = this.options.environment?.() ?? process.env;
    const environment: Record<string, string> = {};
    for (const name of names) {
      const value = available[name];
      if (!value || value.includes('\0') || value.length > 16000)
        throw new ToolRefusal(
          'CAPABILITY_DENIED',
          `Deployment environment reference is unavailable: ${name}`,
        );
      environment[name] = value;
    }
    return environment;
  }

  private async resolve(sessionId: string, input: DeploymentInspect) {
    if (sessionId !== input.target.sessionId)
      throw new ToolRefusal('REVISION_CONFLICT', 'Deployment session changed');
    const root = this.options.resolveTarget(sessionId, input.target);
    const config = this.options.config(input.target.projectId);
    const profile = config?.deployments?.find((item) => item.id === input.profileId);
    if (!config || !profile)
      throw new ToolRefusal('TARGET_NOT_FOUND', 'Deployment profile is unavailable');
    const environment = this.environment(profile.envRefs);
    const status = await readUserGitStatus(root);
    if (status.truncated || status.entries.some((entry) => entry.kind === 'unmerged'))
      throw new ToolRefusal('CAPABILITY_DENIED', 'Resolve Git conflicts before deployment');
    const tree = await this.options.snapshot(root);
    const launch = await launchFingerprint(root, config.revision, profile);
    const readback = await launchFingerprint(root, config.revision, {
      ...profile,
      argv: profile.readbackArgv,
    });
    const source = { commit: status.head.oid, tree, dirty: status.entries.length > 0 };
    const content = { target: input.target, profile, configRevision: config.revision, source };
    const environmentHash = hash(environment);
    return {
      root,
      environment,
      launch,
      readback,
      environmentHash,
      plan: {
        ...content,
        fingerprint: hash({
          ...content,
          launch: launch.fingerprint,
          readback: readback.fingerprint,
          environmentHash,
        }),
      },
    };
  }

  async inspect(sessionId: string, raw: DeploymentInspect): Promise<DeploymentPlan> {
    return (await this.resolve(sessionId, DeploymentInspect.parse(raw))).plan;
  }

  list(sessionId: string, projectId: string): DeploymentList {
    return {
      profiles: this.options.config(projectId)?.deployments ?? [],
      deployments: this.options.operations
        .list('deployment', sessionId)
        .reverse()
        .slice(0, 20)
        .map((item) => this.get(sessionId, item.operationId)),
    };
  }

  private receipt(sessionId: string, operationId: string) {
    const receipt = this.options.operations.get(operationId);
    if (receipt?.kind !== 'deployment' || receipt.target.sessionId !== sessionId)
      throw new ToolRefusal('TARGET_NOT_FOUND', 'Deployment is unavailable');
    return receipt;
  }

  get(sessionId: string, operationId: string): DeploymentView {
    const receipt = this.receipt(sessionId, operationId),
      stored = receipt.result as Stored;
    return {
      operationId,
      target: receipt.target,
      state: receipt.state,
      plan: stored.plan,
      phase: stored.phase,
      exitCode: stored.exitCode,
      cleanupConfirmed: stored.cleanupConfirmed,
      readback: stored.readback,
      reason: stored.reason,
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
    };
  }

  private record(operationId: string, stored: Stored) {
    this.options.db
      .prepare(
        "UPDATE workbench_operations SET result_json=? WHERE operation_id=? AND state IN ('running','uncertain')",
      )
      .run(JSON.stringify(stored), operationId);
  }

  async start(sessionId: string, raw: DeploymentStart): Promise<DeploymentView> {
    const input = DeploymentStart.parse(raw),
      requestHash = hash(input);
    const existing = this.options.operations.get(input.operationId);
    if (existing) {
      if (
        existing.kind !== 'deployment' ||
        existing.requestHash !== requestHash ||
        existing.target.sessionId !== sessionId
      )
        throw new ToolRefusal('REVISION_CONFLICT', 'Deployment operation request changed');
      return this.get(sessionId, input.operationId);
    }
    const root = this.options.resolveTarget(sessionId, input.target);
    return this.options.lease(root, async () => {
      const resolved = await this.resolve(sessionId, input);
      if (resolved.plan.fingerprint !== input.fingerprint)
        throw new ToolRefusal(
          'REVISION_CONFLICT',
          'Deployment source, command or environment changed; review it again',
        );
      if (resolved.plan.source.dirty && !input.allowDirty)
        throw new ToolRefusal(
          'CAPABILITY_DENIED',
          'Confirm deployment of the changed working copy',
        );
      if (this.options.resolveTarget(sessionId, input.target) !== root)
        throw new ToolRefusal('REVISION_CONFLICT', 'Deployment copy changed during review');
      const stored: Stored = {
        plan: resolved.plan,
        phase: 'deploy',
        exitCode: null,
        cleanupConfirmed: false,
        readback: null,
        reason: null,
        activeId: input.operationId,
        attempt: 0,
        readbackFingerprint: resolved.readback.fingerprint,
        environmentHash: resolved.environmentHash,
      };
      const admitted = this.options.operations.admit(
        { operationId: input.operationId, target: input.target, kind: 'deployment', requestHash },
        root,
        stored,
      );
      if (!admitted.admitted) return this.get(sessionId, input.operationId);
      try {
        await this.launch(
          sessionId,
          input.operationId,
          stored,
          root,
          resolved.launch.executable,
          input.operationId,
          resolved.environment,
          false,
        );
      } catch {
        stored.phase = 'settled';
        stored.cleanupConfirmed = true;
        stored.reason = 'launch_failed';
        this.options.operations.finish(input.operationId, 'failed', stored);
      }
      return this.get(sessionId, input.operationId);
    });
  }

  private async launch(
    sessionId: string,
    operationId: string,
    stored: Stored,
    root: string,
    executable: string,
    runtimeId: string,
    environment: Record<string, string>,
    readback: boolean,
  ) {
    const plan = stored.plan;
    const launched = this.options.runtime.startService(
      {
        operationId: runtimeId,
        owner: { kind: 'user', hostId: plan.target.hostId, sessionId, operationId },
        directory: root,
        command: {
          executable,
          args: (readback ? plan.profile.readbackArgv : plan.profile.argv).slice(1),
        },
        timeoutMs: plan.profile.timeoutMs,
        secrets: Object.values(environment),
        environment: {
          ...environment,
          CORRAL_PROCESS_OWNER: operationId,
          CORRAL_DEPLOYMENT_OPERATION: operationId,
          CORRAL_DEPLOYMENT_ENVIRONMENT: plan.profile.environment,
          CORRAL_DEPLOYMENT_COMMIT: plan.source.commit ?? '',
          CORRAL_DEPLOYMENT_TREE: plan.source.tree,
        },
      },
      noCancel,
    );
    let started = false;
    const completion = launched.completion
      .then((report) => {
        const current = this.receipt(sessionId, operationId);
        if (
          !['running', 'uncertain'].includes(current.state) ||
          (current.result as Stored).activeId !== runtimeId
        )
          return;
        stored.cleanupConfirmed = report.cleanupConfirmed;
        stored.phase = 'settled';
        if (!readback) {
          stored.exitCode = report.exitCode;
          stored.reason = !started
            ? 'launch_failed'
            : report.timedOut
              ? 'command_timeout'
              : report.exitCode === 0
                ? 'result_unconfirmed'
                : 'command_failed_result_unconfirmed';
          this.options.operations.finish(
            operationId,
            !started && report.cleanupConfirmed ? 'failed' : 'uncertain',
            stored,
          );
        } else this.confirm(operationId, stored, report);
      })
      .catch(() => {
        // A lost receipt write never authorizes releasing the copy or re-running deployment.
        this.options.operations.finish(operationId, 'uncertain', {
          ...stored,
          reason: 'receipt_unconfirmed',
        });
      })
      .finally(() => this.pending.delete(operationId));
    this.pending.set(operationId, completion);
    started = await launched.started;
    const pid = this.options.runtime.pid(runtimeId);
    if (pid && process.platform === 'linux') {
      try {
        stored.processIdentity = capturePtySession(pid, operationId);
        this.record(operationId, stored);
      } catch {
        /* A fast exit is confirmed by completion. */
      }
    }
  }

  private confirm(operationId: string, stored: Stored, report: OwnedCommandReport) {
    let result: DeploymentReadback | null = null;
    if (
      report.cleanupConfirmed &&
      report.state === 'completed' &&
      report.exitCode === 0 &&
      !report.output.truncated
    ) {
      try {
        const parsed = DeploymentReadback.parse(JSON.parse(report.output.text));
        if (
          parsed.operationId === operationId &&
          parsed.environment === stored.plan.profile.environment &&
          parsed.sourceTree === stored.plan.source.tree &&
          parsed.sourceCommit === stored.plan.source.commit &&
          (!stored.readback || stored.readback.deploymentId === parsed.deploymentId)
        )
          result = parsed;
      } catch {
        /* Malformed, redacted or foreign output is not deployment evidence. */
      }
    }
    stored.readback = result ?? stored.readback;
    stored.reason = result
      ? result.status === 'pending'
        ? 'deployment_pending'
        : null
      : 'readback_unconfirmed';
    this.record(operationId, stored);
    if (result && result.status !== 'pending' && report.cleanupConfirmed)
      this.options.operations.reconcile(operationId, ['deployment'], result.status, stored);
  }

  private action(sessionId: string, operationId: string, raw: DeploymentAction) {
    const input = DeploymentAction.parse(raw),
      receipt = this.receipt(sessionId, operationId);
    if (canonicalJson(receipt.target) !== canonicalJson(input.target))
      throw new ToolRefusal('REVISION_CONFLICT', 'Deployment target changed');
    const root = this.options.resolveTarget(sessionId, input.target);
    return { receipt, root, stored: receipt.result as Stored };
  }

  async check(
    sessionId: string,
    operationId: string,
    raw: DeploymentAction,
  ): Promise<DeploymentView> {
    const { receipt, root, stored } = this.action(sessionId, operationId, raw);
    if (receipt.state !== 'uncertain' || this.pending.has(operationId))
      return this.get(sessionId, operationId);
    if (!stored.cleanupConfirmed)
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'Stop and confirm local process cleanup before checking the deployment',
      );
    return this.options.lease(root, async () => {
      if (this.pending.has(operationId)) return this.get(sessionId, operationId);
      const environment = this.environment(stored.plan.profile.envRefs);
      const launch = await launchFingerprint(root, stored.plan.configRevision, {
        ...stored.plan.profile,
        argv: stored.plan.profile.readbackArgv,
      });
      if (
        launch.fingerprint !== stored.readbackFingerprint ||
        hash(environment) !== stored.environmentHash
      )
        throw new ToolRefusal(
          'REVISION_CONFLICT',
          'The reviewed readback command or credentials changed',
        );
      stored.attempt += 1;
      stored.activeId = `deployment_check_${hash({ operationId, attempt: stored.attempt }).slice(0, 40)}`;
      stored.phase = 'readback';
      stored.cleanupConfirmed = false;
      delete stored.processIdentity;
      this.record(operationId, stored);
      try {
        await this.launch(
          sessionId,
          operationId,
          stored,
          root,
          launch.executable,
          stored.activeId,
          environment,
          true,
        );
      } catch {
        stored.phase = 'settled';
        stored.cleanupConfirmed = true;
        stored.reason = 'readback_unavailable';
        this.record(operationId, stored);
      }
      await this.pending.get(operationId);
      return this.get(sessionId, operationId);
    });
  }

  async stop(
    sessionId: string,
    operationId: string,
    raw: DeploymentAction,
  ): Promise<DeploymentView> {
    const { receipt, stored } = this.action(sessionId, operationId, raw);
    if (!['running', 'uncertain'].includes(receipt.state)) return this.get(sessionId, operationId);
    const report = await this.options.runtime.stop(stored.activeId);
    await this.pending.get(operationId);
    let cleaned = report?.cleanupConfirmed ?? stored.cleanupConfirmed;
    if (!cleaned && stored.processIdentity)
      cleaned = await cleanupPtySession(stored.processIdentity);
    if (cleaned) {
      if (stored.processIdentity) confirmOwnedProcessCleanup(stored.processIdentity.pid);
      this.recovered.get(operationId)?.releaseConfirmed();
      this.recovered.delete(operationId);
      this.options.operations.reconcile(operationId, ['deployment'], 'cancelled', {
        ...stored,
        phase: 'settled',
        cleanupConfirmed: true,
        reason: 'stopped_remote_unknown',
      });
    }
    return this.get(sessionId, operationId);
  }

  dispose() {
    // Unconfirmed recovered groups keep their common host reservations until explicit cleanup.
    this.pending.clear();
  }
}
