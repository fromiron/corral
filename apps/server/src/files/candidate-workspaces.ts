import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  type Clock,
  canonicalJson,
  Identifier,
  TERMINAL_EXECUTION_STATUSES,
} from '@corral/contracts';
import { type RunProjection, ToolRefusal } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import { checkGitEnvironment, git, gitText } from './git.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface CandidateCopy {
  run_id: string;
  candidate_id: string;
  session_id: string;
  binding_id: string;
  copy_generation: number;
  worktree_path: string;
  baseline_tree: string;
  state: 'creating' | 'ready' | 'removed' | 'uncertain';
}
export interface CandidateTarget {
  sessionId: string;
  bindingId: string;
  copyGeneration: number;
  path: string;
}
interface CandidateOptions {
  db: Db;
  clock: Clock;
  root: string;
  target: (runId: string) => CandidateTarget;
  snapshot: (path: string) => Promise<string>;
  lease: <T>(path: string, work: () => Promise<T>) => Promise<T>;
}

/** Candidate copies share Git objects, never writable files or a session-copy fallback. */
export class CandidateWorkspaces {
  private readonly options: CandidateOptions;
  constructor(options: CandidateOptions) {
    this.options = options;
  }

  enabled(runId: string): boolean {
    return Boolean(
      this.options.db
        .prepare(
          "SELECT 1 FROM runs WHERE id=? AND json_type(snapshot_json,'$.autoRoute.ultra.comparison.modelProfiles')='array'",
        )
        .get(runId),
    );
  }

  private copy(runId: string, candidateId: string): CandidateCopy {
    const copy = this.options.db
      .prepare('SELECT * FROM candidate_worktrees WHERE run_id=? AND candidate_id=?')
      .get(runId, candidateId) as CandidateCopy | undefined;
    if (copy?.state !== 'ready')
      throw new ToolRefusal('TARGET_NOT_FOUND', 'candidate working copy is unavailable');
    const target = this.options.target(runId);
    if (
      copy.session_id !== target.sessionId ||
      copy.binding_id !== target.bindingId ||
      copy.copy_generation !== target.copyGeneration
    )
      throw new ToolRefusal('REVISION_CONFLICT', 'candidate working copy target changed');
    try {
      if (realpathSync.native(copy.worktree_path) !== resolve(copy.worktree_path))
        throw new Error('changed');
    } catch {
      throw new ToolRefusal('REVISION_CONFLICT', 'candidate working copy identity changed');
    }
    return copy;
  }

  executionActive(runId: string, executionId: string, attemptNo: number | undefined): boolean {
    const run = this.options.db.prepare('SELECT projection_json FROM runs WHERE id=?').get(runId) as
      | { projection_json: string }
      | undefined;
    const execution = run
      ? (JSON.parse(run.projection_json) as RunProjection).executions?.[executionId]
      : undefined;
    return Boolean(
      execution &&
        execution.attemptNo === attemptNo &&
        !TERMINAL_EXECUTION_STATUSES.has(execution.status),
    );
  }

  forExecution(runId: string, executionId: string): CandidateCopy | null {
    const row = this.options.db
      .prepare('SELECT candidate_id FROM candidate_executions WHERE run_id=? AND execution_id=?')
      .get(runId, executionId) as { candidate_id: string } | undefined;
    const run = this.options.db.prepare('SELECT projection_json FROM runs WHERE id=?').get(runId) as
      | { projection_json: string }
      | undefined;
    const execution = run
      ? (JSON.parse(run.projection_json) as RunProjection).executions?.[executionId]
      : undefined;
    if (row) {
      if (execution?.candidateId !== row.candidate_id)
        throw new ToolRefusal('REVISION_CONFLICT', 'candidate execution identity changed');
      return this.copy(runId, row.candidate_id);
    }
    if (this.enabled(runId) && execution?.nodeId !== 'plan')
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'candidate execution has no assigned working copy',
      );
    return null;
  }

  bind(runId: string, candidateId: string, executionId: string): void {
    Identifier.parse(executionId);
    this.copy(runId, candidateId);
    const run = this.options.db
      .prepare('SELECT projection_json FROM runs WHERE id=?')
      .get(runId) as { projection_json: string };
    const execution = (JSON.parse(run.projection_json) as RunProjection).executions?.[executionId];
    if (execution?.candidateId !== candidateId)
      throw new ToolRefusal('REVISION_CONFLICT', 'candidate execution identity does not match');
    const previous = this.options.db
      .prepare('SELECT candidate_id FROM candidate_executions WHERE run_id=? AND execution_id=?')
      .get(runId, executionId) as { candidate_id: string } | undefined;
    if (previous && previous.candidate_id !== candidateId)
      throw new ToolRefusal(
        'REVISION_CONFLICT',
        'candidate execution identity is already assigned',
      );
    this.options.db
      .prepare(
        'INSERT OR IGNORE INTO candidate_executions(run_id,execution_id,candidate_id) VALUES(?,?,?)',
      )
      .run(runId, executionId, candidateId);
  }

  async prepare(
    runId: string,
    candidateIds: string[],
    baselineTree: string,
  ): Promise<{ baselineTree: string }> {
    if (
      !this.enabled(runId) ||
      candidateIds.length < 2 ||
      candidateIds.length > 5 ||
      new Set(candidateIds).size !== candidateIds.length
    )
      throw new ToolRefusal(
        'SCHEMA_INVALID',
        'candidate comparison requires two to five distinct candidates',
      );
    for (const id of candidateIds) Identifier.parse(id);
    const target = this.options.target(runId);
    return this.options.lease(target.path, async () => {
      const previous = this.options.db
        .prepare('SELECT * FROM candidate_worktrees WHERE run_id=?')
        .all(runId) as CandidateCopy[];
      if (previous.length) {
        if (
          previous.length !== candidateIds.length ||
          previous.some(
            (copy) =>
              !candidateIds.includes(copy.candidate_id) || copy.baseline_tree !== baselineTree,
          )
        )
          throw new ToolRefusal('REVISION_CONFLICT', 'candidate preparation identity changed');
        for (const id of candidateIds) this.copy(runId, id);
        return { baselineTree };
      }
      if ((await this.options.snapshot(target.path)) !== baselineTree)
        throw new ToolRefusal('REVISION_CONFLICT', 'candidate baseline changed before preparation');
      const env = await checkGitEnvironment(target.path);
      const now = this.options.clock.nowIso();
      const commit = await gitText(
        target.path,
        ['commit-tree', baselineTree, '-m', 'Corral candidate baseline'],
        {
          ...env,
          GIT_AUTHOR_NAME: 'Corral',
          GIT_AUTHOR_EMAIL: 'corral@localhost',
          GIT_COMMITTER_NAME: 'Corral',
          GIT_COMMITTER_EMAIL: 'corral@localhost',
          GIT_AUTHOR_DATE: now,
          GIT_COMMITTER_DATE: now,
        },
      );
      this.options.db.transaction(() => {
        for (const id of candidateIds)
          this.options.db
            .prepare(
              "INSERT INTO candidate_worktrees(run_id,candidate_id,session_id,binding_id,copy_generation,worktree_path,baseline_tree,state,created_at) VALUES(?,?,?,?,?,?,?,'creating',?)",
            )
            .run(
              runId,
              id,
              target.sessionId,
              target.bindingId,
              target.copyGeneration,
              join(this.options.root, digest(`${runId}:${id}`)),
              baselineTree,
              now,
            );
      })();
      try {
        for (const id of candidateIds) {
          const path = join(this.options.root, digest(`${runId}:${id}`));
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await git(target.path, ['worktree', 'add', '--detach', path, commit], { env });
          if ((await this.options.snapshot(path)) !== baselineTree)
            throw new Error('candidate checkout does not preserve its baseline');
          this.options.db
            .prepare(
              "UPDATE candidate_worktrees SET state='ready' WHERE run_id=? AND candidate_id=?",
            )
            .run(runId, id);
        }
      } catch (error) {
        this.options.db
          .prepare("UPDATE candidate_worktrees SET state='uncertain' WHERE run_id=?")
          .run(runId);
        throw error;
      }
      return { baselineTree };
    });
  }

  async tree(runId: string, candidateId: string): Promise<string> {
    const copy = this.copy(runId, candidateId);
    if ((await realpath(copy.worktree_path)) !== resolve(copy.worktree_path))
      throw new ToolRefusal('REVISION_CONFLICT', 'candidate working copy identity changed');
    return this.options.lease(copy.worktree_path, async () => {
      const tree = await this.options.snapshot(copy.worktree_path);
      await git(copy.worktree_path, [
        'update-ref',
        `refs/corral/${copy.session_id}/candidates/${digest(`${runId}:${candidateId}`)}`,
        tree,
      ]);
      return tree;
    });
  }

  async inspect(runId: string, candidateId: string, expectedTree: string): Promise<CandidateCopy> {
    const copy = this.copy(runId, candidateId);
    if ((await this.tree(runId, candidateId)) !== expectedTree)
      throw new ToolRefusal('REVISION_CONFLICT', 'candidate tree changed');
    return copy;
  }

  assertSettled(runId: string): void {
    const row = this.options.db
      .prepare('SELECT status,projection_json FROM runs WHERE id=?')
      .get(runId) as { status: string; projection_json: string };
    if (!['running', 'awaiting_user'].includes(row.status))
      throw new ToolRefusal('TARGET_TERMINAL', 'candidate comparison no longer permits promotion');
    const projection = JSON.parse(row.projection_json) as RunProjection;
    if (
      Object.values(projection.executions ?? {}).some(
        (execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status),
      ) ||
      Object.values(projection.budget?.reservations ?? {}).some(
        (reservation) => reservation.status !== 'settled',
      ) ||
      this.options.db
        .prepare(
          "SELECT 1 FROM effect_intents WHERE run_id=? AND (status!='settled' OR outcome='unknown') LIMIT 1",
        )
        .get(runId)
    )
      throw new ToolRefusal(
        'REVISION_CONFLICT',
        'candidate workers and effects must be settled before promotion',
      );
    if (
      this.options.db
        .prepare(
          "SELECT 1 FROM file_operations WHERE run_id=? AND state IN ('planned','uncertain') LIMIT 1",
        )
        .get(runId)
    )
      throw new ToolRefusal('REVISION_CONFLICT', 'candidate file writes are not settled');
  }

  selection(
    input: {
      runId: string;
      candidateId: string;
      expectedTree: string;
      baselineTree: string;
      commandId: string;
    },
    claim = false,
  ) {
    const requestHash = digest(canonicalJson(input));
    const previous = this.options.db
      .prepare(
        'SELECT request_hash,command_id,checkpoint_id FROM candidate_promotions WHERE run_id=?',
      )
      .get(input.runId) as
      | { request_hash: string; command_id: string; checkpoint_id: string }
      | undefined;
    if (previous && previous.request_hash !== requestHash)
      throw new ToolRefusal(
        'REVISION_CONFLICT',
        'a different candidate selection already owns promotion',
      );
    const checkpointId = previous?.checkpoint_id ?? `candidate_${digest(input.runId).slice(0, 32)}`;
    if (claim && !previous)
      this.options.db
        .prepare(
          'INSERT INTO candidate_promotions(run_id,request_hash,command_id,checkpoint_id) VALUES(?,?,?,?)',
        )
        .run(input.runId, requestHash, input.commandId, checkpointId);
    return { checkpointId, previous: Boolean(previous) };
  }

  async remove(sessionId: string, repository: string): Promise<void> {
    const copies = this.options.db
      .prepare("SELECT * FROM candidate_worktrees WHERE session_id=? AND state!='removed'")
      .all(sessionId) as CandidateCopy[];
    for (const copy of copies) {
      if (existsSync(copy.worktree_path))
        await git(repository, ['worktree', 'remove', '--force', copy.worktree_path], {
          env: await checkGitEnvironment(repository),
        });
      this.options.db
        .prepare("UPDATE candidate_worktrees SET state='removed' WHERE run_id=? AND candidate_id=?")
        .run(copy.run_id, copy.candidate_id);
    }
    if (copies.length) await git(repository, ['worktree', 'prune']);
  }
}
