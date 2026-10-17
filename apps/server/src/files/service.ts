import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { editText, PiEditError } from '@corral/adapter-pi';
import {
  type BrokerFileToolName,
  type Clock,
  type EditTextRequest,
  type EditTextResult,
  PiEditInput,
  PiWriteInput,
} from '@corral/contracts';
import { type FileTools, rankFuzzy, type ToolCancellation, ToolRefusal } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import { GitError, git, gitText } from './git.ts';

// Work folders and file changes (CR-012). A project may link one folder, which is only
// observed. A session gets its own git worktree outside that folder; agents change files
// there only through the broker below, which records what it is about to do before doing it.
// Snapshots are git trees written from a temporary index, pinned under refs/corral/.

const MAX_TEXT = 1024 * 1024;
const OUTPUT_TAIL = 64 * 1024;

export interface VerifyCommand {
  id: string;
  name: string;
  argv: string[];
  timeoutMs: number;
}

export interface BindingView {
  bindingId: string;
  projectId: string;
  /** The folder's name and its parent, never the whole path in lists (shown in full on request). */
  path: string;
  isGit: boolean;
  trusted: boolean;
  verifyCommands: VerifyCommand[];
  status: { branch: string | null; head: string | null; changed: number } | null;
  /** The folder is no longer where it was linked. */
  missing: boolean;
}

export interface WorktreeView {
  sessionId: string;
  baseCommit: string;
  createdAt: string;
  removedAt: string | null;
  reviewed: boolean;
  /** The working copy's folder is gone (deleted outside Corral). */
  missing: boolean;
}

export type ChangeScope = { kind: 'session' } | { kind: 'review' } | { kind: 'run'; runId: string };
export type FileBrowseScope = { kind: 'project' | 'session'; id: string };

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'type_changed';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  provenance: 'managed_agent' | 'external_observed';
  /** Git blob ids of the two sides (null when absent): a file's identity for "reviewed". */
  beforeBlob: string | null;
  afterBlob: string | null;
}

export interface ChangeSet {
  scope: ChangeScope;
  from: string | null;
  to: string | null;
  /** Why there is nothing to compare, when there is not (no baseline recorded). */
  unavailable: string | null;
  files: FileChange[];
}

export interface FileVersions {
  path: string;
  before: FileSide;
  after: FileSide;
}
export type FileSide =
  | { kind: 'absent' }
  | { kind: 'text'; text: string }
  | { kind: 'binary'; bytes: number }
  | { kind: 'too_large'; bytes: number };

export interface VerificationView {
  verificationId: string;
  commandId: string;
  name: string;
  argv: string[];
  tree: string;
  state: 'running' | 'passed' | 'failed' | 'error';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number | null;
  output: string;
  startedAt: string;
  endedAt: string | null;
  /** The worktree has changed since it ran. */
  stale: boolean;
}

export class WorkspaceError extends Error {
  readonly code: 'TARGET_NOT_FOUND' | 'SCHEMA_INVALID' | 'CAPABILITY_DENIED' | 'REVISION_CONFLICT';
  constructor(code: WorkspaceError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A relative path inside the worktree, or a refusal. Never `..`, absolute, or into `.git`. */
export function safeRelative(input: string): string {
  if (!input || input.includes('\0') || input.includes('\\') || isAbsolute(input))
    throw new ToolRefusal('SCHEMA_INVALID', 'use a relative path with / separators');
  const parts = input.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) throw new ToolRefusal('SCHEMA_INVALID', 'the path names no file');
  if (parts.some((p) => p === '..'))
    throw new ToolRefusal('CAPABILITY_DENIED', 'paths may not leave the working copy');
  if (parts.some((p) => p.toLowerCase() === '.git'))
    throw new ToolRefusal('CAPABILITY_DENIED', '.git is not part of the working copy');
  if (parts[0]?.toLowerCase() === '.corral')
    throw new ToolRefusal('CAPABILITY_DENIED', '.corral holds Corral’s own records');
  return parts.join('/');
}

/** Refuses a path whose existing components include a symbolic link. */
/** Paths considered by one `@` search; larger folders say they were cut. */
const SEARCH_CAP = 50_000;

async function assertPlainPath(root: string, rel: string): Promise<'file' | 'missing' | 'other'> {
  const parts = rel.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch {
      return 'missing';
    }
    if (info.isSymbolicLink())
      throw new ToolRefusal('CAPABILITY_DENIED', `${rel} goes through a symbolic link`);
    if (index < parts.length - 1 && !info.isDirectory()) return 'other';
    if (index === parts.length - 1) return info.isFile() ? 'file' : 'other';
  }
  return 'missing';
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

interface BindingRow {
  id: string;
  project_id: string;
  root_path: string;
  is_git: number;
  trusted: number;
  verify_json: string;
}
interface WorktreeRow {
  session_id: string;
  binding_id: string;
  worktree_path: string;
  base_commit: string;
  base_tree: string;
  reviewed_tree: string | null;
  created_at: string;
  removed_at: string | null;
}

export class WorkspaceService implements FileTools {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly worktreeRoot: string;
  /** Folders that may never be linked: Corral's own data and credentials. */
  private readonly forbidden: string[];
  /** Per-worktree write lease: one Corral write at a time (WB-WSP-003). */
  private readonly leases = new Map<string, Promise<unknown>>();
  /** Run → execution → path hash: another attempt's read never authorizes an overwrite. */
  private readonly reads = new Map<string, Map<string, Map<string, string>>>();
  private readonly edit: (
    request: EditTextRequest,
    cancellation: ToolCancellation,
  ) => Promise<EditTextResult>;

  constructor(options: {
    db: Db;
    clock: Clock;
    worktreeRoot: string;
    forbidden: string[];
    edit?: (request: EditTextRequest, cancellation: ToolCancellation) => Promise<EditTextResult>;
  }) {
    this.db = options.db;
    this.clock = options.clock;
    this.edit = options.edit ?? ((request, cancellation) => editText(request, { cancellation }));
    this.worktreeRoot = resolve(options.worktreeRoot);
    this.forbidden = [...options.forbidden, this.worktreeRoot].map((p) => resolve(p));
    // A write planned before the last stop has an unknown outcome; it is never redone (WB-WSP-005).
    this.db
      .prepare(
        `UPDATE file_operations SET state = 'uncertain', updated_at = ?,
           detail = 'the server stopped between planning and finishing this write'
         WHERE state = 'planned'`,
      )
      .run(this.clock.nowIso());
    this.db
      .prepare(
        `UPDATE verifications SET state = 'error', ended_at = ?,
           output_tail = output_tail || '\n[the server stopped during this check]'
         WHERE state = 'running'`,
      )
      .run(this.clock.nowIso());
  }

  // ── folder links ────────────────────────────────────────────────────────────

  private binding(projectId: string): BindingRow | null {
    return (
      (this.db.prepare('SELECT * FROM workspace_bindings WHERE project_id = ?').get(projectId) as
        | BindingRow
        | undefined) ?? null
    );
  }

  async view(projectId: string): Promise<BindingView | null> {
    const row = this.binding(projectId);
    if (!row) return null;
    let status: BindingView['status'] = null;
    // A folder moved or deleted since it was linked (02-UX-Spec §8): said, not guessed around.
    const missing = !(await stat(row.root_path).then(
      (info) => info.isDirectory(),
      () => false,
    ));
    if (row.is_git && !missing) {
      try {
        const branch = await gitText(row.root_path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(
          () => null,
        );
        const head = await gitText(row.root_path, ['rev-parse', '--short', 'HEAD']).catch(
          () => null,
        );
        const porcelain = await git(row.root_path, ['status', '--porcelain=v1', '-z']);
        const changed = porcelain.stdout.toString('utf8').split('\0').filter(Boolean).length;
        status = { branch, head, changed };
      } catch {
        status = null;
      }
    }
    return {
      bindingId: row.id,
      projectId: row.project_id,
      path: row.root_path,
      isGit: row.is_git === 1,
      trusted: row.trusted === 1,
      verifyCommands: JSON.parse(row.verify_json) as VerifyCommand[],
      status,
      missing,
    };
  }

  async bind(projectId: string, path: string): Promise<BindingView> {
    if (this.binding(projectId))
      throw new WorkspaceError('REVISION_CONFLICT', 'this project already has a folder');
    let root: string;
    try {
      root = await realpath(resolve(path));
      if (!(await stat(root)).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new WorkspaceError('TARGET_NOT_FOUND', 'that folder does not exist');
    }
    if (root === sep || root === resolve(process.env.HOME ?? '/nonexistent'))
      throw new WorkspaceError(
        'SCHEMA_INVALID',
        'choose a project folder, not a whole drive or home',
      );
    // A folder holding Corral's data may be linked (its .corral stays out of reach of the file
    // tools); a folder inside Corral's data, credentials or working copies may not.
    for (const blocked of this.forbidden) {
      const inside = relative(blocked, root);
      if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside)))
        throw new WorkspaceError('CAPABILITY_DENIED', 'Corral’s own data cannot be a work folder');
    }
    let isGit = false;
    try {
      const top = await gitText(root, ['rev-parse', '--show-toplevel']);
      isGit = (await realpath(top)) === root;
    } catch {
      isGit = false;
    }
    const now = this.clock.nowIso();
    this.db
      .prepare(
        `INSERT INTO workspace_bindings (id, project_id, root_path, is_git, trusted, verify_json,
           created_at, updated_at) VALUES (?, ?, ?, ?, 0, '[]', ?, ?)`,
      )
      .run(`binding_${randomUUID().slice(0, 8)}`, projectId, root, isGit ? 1 : 0, now, now);
    return (await this.view(projectId)) as BindingView;
  }

  async unbind(projectId: string) {
    const row = this.binding(projectId);
    if (!row) return;
    const active = this.db
      .prepare('SELECT 1 FROM session_worktrees WHERE binding_id = ? AND removed_at IS NULL')
      .get(row.id);
    if (active)
      throw new WorkspaceError('REVISION_CONFLICT', 'remove the sessions’ working copies first');
    this.db.prepare('DELETE FROM session_worktrees WHERE binding_id = ?').run(row.id);
    this.db.prepare('DELETE FROM workspace_bindings WHERE id = ?').run(row.id);
  }

  async configure(
    projectId: string,
    change: { trusted?: boolean; verifyCommands?: VerifyCommand[] },
  ): Promise<BindingView> {
    const row = this.binding(projectId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this project has no folder');
    const trusted = change.trusted ?? row.trusted === 1;
    if (change.verifyCommands && !trusted)
      throw new WorkspaceError('CAPABILITY_DENIED', 'trust the repository before adding checks');
    this.db
      .prepare(
        'UPDATE workspace_bindings SET trusted = ?, verify_json = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        trusted ? 1 : 0,
        JSON.stringify(change.verifyCommands ?? JSON.parse(row.verify_json)),
        this.clock.nowIso(),
        row.id,
      );
    return (await this.view(projectId)) as BindingView;
  }

  // ── session worktrees ───────────────────────────────────────────────────────

  private worktree(sessionId: string): WorktreeRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM session_worktrees WHERE session_id = ? AND removed_at IS NULL')
        .get(sessionId) as WorktreeRow | undefined) ?? null
    );
  }

  worktreeView(sessionId: string): WorktreeView | null {
    const row = this.worktree(sessionId);
    return row
      ? {
          sessionId,
          baseCommit: row.base_commit,
          createdAt: row.created_at,
          removedAt: row.removed_at,
          reviewed: row.reviewed_tree !== null,
          missing: !existsSync(row.worktree_path),
        }
      : null;
  }

  async createWorktree(sessionId: string, projectId: string): Promise<WorktreeView> {
    const binding = this.binding(projectId);
    if (!binding)
      throw new WorkspaceError('TARGET_NOT_FOUND', 'link a folder to the project first');
    if (!binding.is_git)
      throw new WorkspaceError('CAPABILITY_DENIED', 'working copies need a Git repository');
    if (!binding.trusted)
      throw new WorkspaceError('CAPABILITY_DENIED', 'trust the repository before making copies');
    if (this.worktree(sessionId))
      throw new WorkspaceError('REVISION_CONFLICT', 'this session already has a working copy');
    let head: string;
    try {
      head = await gitText(binding.root_path, ['rev-parse', '--verify', 'HEAD^{commit}']);
    } catch {
      throw new WorkspaceError('SCHEMA_INVALID', 'the repository has no commit to start from');
    }
    const path = join(this.worktreeRoot, binding.id, sessionId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await git(binding.root_path, ['worktree', 'add', '--detach', path, head]);
    const tree = await gitText(path, ['rev-parse', `${head}^{tree}`]);
    await this.pin(path, `refs/corral/${sessionId}/base`, tree);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_worktrees (session_id, binding_id, worktree_path,
           base_commit, base_tree, reviewed_tree, created_at, removed_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(sessionId, binding.id, path, head, tree, this.clock.nowIso());
    return this.worktreeView(sessionId) as WorktreeView;
  }

  /** Removes the working copy (its files only); the original folder is not touched. */
  async removeWorktree(sessionId: string) {
    const row = this.worktree(sessionId);
    if (!row) return;
    const binding = this.db
      .prepare('SELECT * FROM workspace_bindings WHERE id = ?')
      .get(row.binding_id) as BindingRow | undefined;
    await this.lease(row.worktree_path, async () => {
      if (binding) {
        await git(binding.root_path, ['worktree', 'remove', '--force', row.worktree_path]).catch(
          () => rm(row.worktree_path, { recursive: true, force: true }),
        );
        await git(binding.root_path, ['worktree', 'prune']).catch(() => undefined);
      }
    });
    this.db
      .prepare('UPDATE session_worktrees SET removed_at = ? WHERE session_id = ?')
      .run(this.clock.nowIso(), sessionId);
  }

  // ── snapshots ───────────────────────────────────────────────────────────────

  private async pin(worktree: string, ref: string, tree: string) {
    await git(worktree, ['update-ref', ref, tree]);
  }

  /** The worktree as a git tree, from a temporary index; .gitignore'd files are left out. */
  private async snapshotTree(worktree: string): Promise<string> {
    const index = join(tmpdir(), `corral-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await git(worktree, ['read-tree', 'HEAD'], { env });
      await git(worktree, ['add', '-A', '--', '.'], { env });
      return await gitText(worktree, ['write-tree'], env);
    } finally {
      await rm(index, { force: true });
    }
  }

  sessionOfRun(runId: string): string | null {
    const row = this.db.prepare('SELECT session_id FROM runs WHERE id = ?').get(runId) as
      | { session_id: string | null }
      | undefined;
    return row?.session_id ?? null;
  }

  /** Records a run's start or end snapshot, inside the write lease so no write is half-seen. */
  async snapshotRun(runId: string, sessionId: string, phase: 'start' | 'end') {
    if (phase === 'end') this.reads.delete(runId);
    const row = this.worktree(sessionId);
    if (!row) return null;
    const existing = this.runTree(runId, phase);
    if (existing) return existing;
    const tree = await this.lease(row.worktree_path, () => this.snapshotTree(row.worktree_path));
    await this.pin(row.worktree_path, `refs/corral/${sessionId}/runs/${runId}/${phase}`, tree);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO run_snapshots (run_id, phase, session_id, tree, captured_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, phase, sessionId, tree, this.clock.nowIso());
    return tree;
  }

  /** Each run's start and end trees in this session, for "was this checked?" on run cards. */
  runSnapshots(sessionId: string) {
    return this.db
      .prepare('SELECT run_id AS runId, phase, tree FROM run_snapshots WHERE session_id = ?')
      .all(sessionId) as { runId: string; phase: 'start' | 'end'; tree: string }[];
  }

  /** A run's start snapshot, taken just before the run was started (CR-012). */
  async recordRunStart(runId: string, sessionId: string, tree: string) {
    const row = this.worktree(sessionId);
    if (!row) return;
    await this.pin(row.worktree_path, `refs/corral/${sessionId}/runs/${runId}/start`, tree);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO run_snapshots (run_id, phase, session_id, tree, captured_at)
         VALUES (?, 'start', ?, ?, ?)`,
      )
      .run(runId, sessionId, tree, this.clock.nowIso());
  }

  private runTree(runId: string, phase: 'start' | 'end'): string | null {
    const row = this.db
      .prepare('SELECT tree FROM run_snapshots WHERE run_id = ? AND phase = ?')
      .get(runId, phase) as { tree: string } | undefined;
    return row?.tree ?? null;
  }

  /** Marks what is there now as reviewed: the "since last review" scope starts here. */
  async markReviewed(sessionId: string) {
    const row = this.worktree(sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    const tree = await this.lease(row.worktree_path, () => this.snapshotTree(row.worktree_path));
    await this.pin(row.worktree_path, `refs/corral/${sessionId}/reviewed`, tree);
    this.db
      .prepare(
        'UPDATE session_worktrees SET reviewed_tree = ?, reviewed_at = ? WHERE session_id = ?',
      )
      .run(tree, this.clock.nowIso(), sessionId);
  }

  // ── comparing ───────────────────────────────────────────────────────────────

  private async trees(
    sessionId: string,
    scope: ChangeScope,
    runEnded: (runId: string) => boolean,
  ): Promise<{
    from: string | null;
    to: string | null;
    unavailable: string | null;
    row: WorktreeRow;
  }> {
    const row = this.worktree(sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    const now = async () => {
      const tree = await this.lease(row.worktree_path, () => this.snapshotTree(row.worktree_path));
      await this.pin(row.worktree_path, `refs/corral/${sessionId}/latest`, tree);
      return tree;
    };
    if (scope.kind === 'session')
      return { from: row.base_tree, to: await now(), unavailable: null, row };
    if (scope.kind === 'review')
      return { from: row.reviewed_tree ?? row.base_tree, to: await now(), unavailable: null, row };
    const start = this.runTree(scope.runId, 'start');
    if (!start)
      return { from: null, to: null, unavailable: 'no baseline was recorded for this run', row };
    const end = runEnded(scope.runId)
      ? ((await this.snapshotRun(scope.runId, sessionId, 'end')) ?? (await now()))
      : await now();
    return { from: start, to: end, unavailable: null, row };
  }

  async changes(
    sessionId: string,
    scope: ChangeScope,
    runEnded: (runId: string) => boolean,
  ): Promise<ChangeSet> {
    const { from, to, unavailable, row } = await this.trees(sessionId, scope, runEnded);
    if (!from || !to) return { scope, from, to, unavailable, files: [] };
    const raw = (
      await git(row.worktree_path, ['diff-tree', '-r', '-z', '--no-renames', '--raw', from, to])
    ).stdout
      .toString('utf8')
      .split('\0');
    const numstat = (
      await git(row.worktree_path, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', from, to])
    ).stdout
      .toString('utf8')
      .split('\0');
    const counts = new Map<string, { add: number | null; del: number | null }>();
    for (const line of numstat) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(line);
      if (match)
        counts.set(match[3] as string, {
          add: match[1] === '-' ? null : Number(match[1]),
          del: match[2] === '-' ? null : Number(match[2]),
        });
    }
    const managed = this.managedPaths(sessionId, scope.kind === 'run' ? scope.runId : null);
    const files: FileChange[] = [];
    for (let i = 0; i < raw.length - 1; i += 2) {
      const meta = raw[i] as string;
      const path = raw[i + 1] as string;
      const fields = meta.trim().split(' ');
      const status = fields.at(-1)?.[0];
      if (!status || !path) continue;
      const blob = (sha: string | undefined) => (sha && !/^0+$/.test(sha) ? sha : null);
      const count = counts.get(path);
      files.push({
        path,
        status:
          status === 'A'
            ? 'added'
            : status === 'D'
              ? 'deleted'
              : status === 'T'
                ? 'type_changed'
                : 'modified',
        additions: count?.add ?? null,
        deletions: count?.del ?? null,
        binary: count ? count.add === null : false,
        provenance: managed.has(path) ? 'managed_agent' : 'external_observed',
        beforeBlob: blob(fields[2]),
        afterBlob: blob(fields[3]),
      });
    }
    return { scope, from, to, unavailable: null, files };
  }

  private managedPaths(sessionId: string, runId: string | null): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT path, to_path FROM file_operations WHERE session_id = ? AND state = 'applied'
           AND (? IS NULL OR run_id = ?)`,
      )
      .all(sessionId, runId, runId) as { path: string; to_path: string | null }[];
    return new Set(rows.flatMap((r) => (r.to_path ? [r.path, r.to_path] : [r.path])));
  }

  async fileVersions(
    sessionId: string,
    from: string,
    to: string,
    path: string,
  ): Promise<FileVersions> {
    const row = this.worktree(sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    const rel = safeRelative(path);
    // One git process per side, both at once (02-UX-Spec §11: diff display p95 ≤ 500 ms).
    const side = async (tree: string): Promise<FileSide> => {
      let content: Buffer;
      try {
        content = (await git(row.worktree_path, ['cat-file', 'blob', `${tree}:${rel}`])).stdout;
      } catch {
        return { kind: 'absent' };
      }
      if (content.length > MAX_TEXT) return { kind: 'too_large', bytes: content.length };
      const text = decodeText(content);
      return text === null ? { kind: 'binary', bytes: content.length } : { kind: 'text', text };
    };
    const [before, after] = await Promise.all([side(from), side(to)]);
    return { path: rel, before, after };
  }

  // ── the linked folder as Git sees it (02-UX-Spec §4 "Git 상태") ─────────────

  /**
   * HEAD → the folder's working tree, staged and unstaged together, plus untracked files.
   * Read only: `git diff` without optional locks writes nothing, not even the index.
   */
  async folderChanges(projectId: string): Promise<ChangeSet & { staged: string[] }> {
    const row = this.binding(projectId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this project has no folder');
    if (!row.is_git)
      throw new WorkspaceError('CAPABILITY_DENIED', 'the folder is not a Git repository');
    const root = row.root_path;
    const head = await gitText(root, ['rev-parse', '--verify', 'HEAD^{tree}']).catch(() => null);
    if (!head)
      return {
        scope: { kind: 'session' },
        from: null,
        to: null,
        unavailable: 'the repository has no commit',
        files: [],
        staged: [],
      };
    const split = async (args: string[]) =>
      (await git(root, args)).stdout.toString('utf8').split('\0');
    const raw = await split(['diff', '--no-renames', '-z', '--raw', 'HEAD']);
    const numstat = await split(['diff', '--no-renames', '-z', '--numstat', 'HEAD']);
    const staged = (
      await split(['diff', '--cached', '--no-renames', '-z', '--name-only', 'HEAD'])
    ).filter(Boolean);
    const untracked = (await split(['ls-files', '-z', '--others', '--exclude-standard'])).filter(
      Boolean,
    );
    const counts = new Map<string, { add: number | null; del: number | null }>();
    for (const line of numstat) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(line);
      if (match)
        counts.set(match[3] as string, {
          add: match[1] === '-' ? null : Number(match[1]),
          del: match[2] === '-' ? null : Number(match[2]),
        });
    }
    const files: FileChange[] = [];
    for (let i = 0; i < raw.length - 1; i += 2) {
      const fields = (raw[i] as string).trim().split(' ');
      const path = raw[i + 1] as string;
      const status = fields.at(-1)?.[0];
      if (!status || !path) continue;
      const count = counts.get(path);
      files.push({
        path,
        status:
          status === 'A'
            ? 'added'
            : status === 'D'
              ? 'deleted'
              : status === 'T'
                ? 'type_changed'
                : 'modified',
        additions: count?.add ?? null,
        deletions: count?.del ?? null,
        binary: count ? count.add === null : false,
        provenance: 'external_observed',
        beforeBlob: fields[2] && !/^0+$/.test(fields[2]) ? fields[2] : null,
        afterBlob: null,
      });
    }
    for (const path of untracked.slice(0, 2000))
      files.push({
        path,
        status: 'added',
        additions: null,
        deletions: null,
        binary: false,
        provenance: 'external_observed',
        beforeBlob: null,
        afterBlob: null,
      });
    return { scope: { kind: 'session' }, from: head, to: null, unavailable: null, files, staged };
  }

  /** One file: as committed at HEAD, and as it is on disk now (never written). */
  async folderFileVersions(projectId: string, path: string): Promise<FileVersions> {
    const row = this.binding(projectId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this project has no folder');
    const rel = safeRelative(path);
    let before: FileSide = { kind: 'absent' };
    try {
      const sha = await gitText(row.root_path, ['rev-parse', '--verify', '--quiet', `HEAD:${rel}`]);
      const bytes = Number(await gitText(row.root_path, ['cat-file', '-s', sha]));
      if (bytes > MAX_TEXT) before = { kind: 'too_large', bytes };
      else {
        const content = (await git(row.root_path, ['cat-file', 'blob', sha])).stdout;
        const text = decodeText(content);
        before = text === null ? { kind: 'binary', bytes } : { kind: 'text', text };
      }
    } catch {
      before = { kind: 'absent' };
    }
    let after: FileSide = { kind: 'absent' };
    if ((await assertPlainPath(row.root_path, rel)) === 'file') {
      const content = await readFile(join(row.root_path, rel));
      if (content.length > MAX_TEXT) after = { kind: 'too_large', bytes: content.length };
      else {
        const text = decodeText(content);
        after = text === null ? { kind: 'binary', bytes: content.length } : { kind: 'text', text };
      }
    }
    return { path: rel, before, after };
  }

  // ── verification commands ───────────────────────────────────────────────────

  /** Human inspection never updates the agent's read-before-write ledger. */
  private async browseRoot(scope: FileBrowseScope) {
    const binding = scope.kind === 'project' ? this.binding(scope.id) : null;
    const copy = scope.kind === 'session' ? this.worktree(scope.id) : null;
    const root = binding?.root_path ?? copy?.worktree_path;
    if (!root || !existsSync(root))
      throw new WorkspaceError('TARGET_NOT_FOUND', 'the linked folder is unavailable');
    if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
      throw new WorkspaceError('CAPABILITY_DENIED', 'the linked folder has moved');
    return { root, isGit: binding ? !!binding.is_git : true };
  }

  async listFiles(scope: FileBrowseScope, path = '') {
    const { root, isGit } = await this.browseRoot(scope);
    return this.list(root, path, isGit);
  }

  /**
   * CR-016: files and folders for an `@` reference, ranked by a fuzzy match of their path. Only
   * names are read; Git's ignore rules apply, and nothing behind a symbolic link is returned.
   */
  async searchPaths(
    scope: FileBrowseScope,
    query: string,
    limit: number,
  ): Promise<{ items: { path: string; kind: 'file' | 'folder' }[]; truncated: boolean }> {
    const { root, isGit } = await this.browseRoot(scope);
    const walk = isGit ? null : await this.folderPaths(root, '');
    const listed =
      walk?.paths ??
      (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
    const paths = [...new Set(listed)].slice(0, SEARCH_CAP).filter((path) => {
      try {
        safeRelative(path);
        return true;
      } catch {
        return false;
      }
    });
    const folders = new Set<string>();
    for (const path of paths) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    const candidates = [
      ...[...folders]
        .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
        .map((path) => ({ path, kind: 'folder' as const })),
      ...paths.map((path) => ({ path, kind: 'file' as const })),
    ];
    const ranked = rankFuzzy(
      query,
      candidates,
      (item) => (item.kind === 'folder' ? `${item.path}/` : item.path),
      limit * 3,
    );
    const items: { path: string; kind: 'file' | 'folder' }[] = [];
    for (const item of ranked) {
      if (items.length >= limit) break;
      try {
        if (item.kind === 'file') {
          if ((await assertPlainPath(root, item.path)) === 'file') items.push(item);
        } else {
          // Throws for a symbolic link anywhere on the way.
          await assertPlainPath(root, item.path);
          if ((await lstat(join(root, item.path))).isDirectory()) items.push(item);
        }
      } catch {
        // A symbolic link or a path that is gone: not offered.
      }
    }
    return { items, truncated: listed.length > SEARCH_CAP || !!walk?.truncated };
  }

  async readFile(
    scope: FileBrowseScope,
    path: string,
  ): Promise<{ path: string; content: FileSide }> {
    const { root } = await this.browseRoot(scope);
    const rel = safeRelative(path);
    if ((await assertPlainPath(root, rel)) !== 'file')
      throw new WorkspaceError('TARGET_NOT_FOUND', 'the file is unavailable');
    const handle = await open(join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile())
        throw new WorkspaceError('CAPABILITY_DENIED', 'only plain files can be read');
      if (info.size > MAX_TEXT)
        return { path: rel, content: { kind: 'too_large', bytes: info.size } };
      const buffer = Buffer.alloc(MAX_TEXT + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_TEXT) return { path: rel, content: { kind: 'too_large', bytes: size } };
      const text = decodeText(buffer.subarray(0, size));
      return {
        path: rel,
        content: text === null ? { kind: 'binary', bytes: size } : { kind: 'text', text },
      };
    } finally {
      await handle.close();
    }
  }

  verifications(sessionId: string, currentTree: string | null): VerificationView[] {
    const rows = this.db
      .prepare('SELECT * FROM verifications WHERE session_id = ? ORDER BY started_at DESC LIMIT 50')
      .all(sessionId) as {
      id: string;
      command_id: string;
      command_json: string;
      tree: string;
      exit_code: number | null;
      signal: string | null;
      timed_out: number;
      duration_ms: number | null;
      output_tail: string;
      state: VerificationView['state'];
      started_at: string;
      ended_at: string | null;
    }[];
    return rows.map((r) => {
      const command = JSON.parse(r.command_json) as VerifyCommand;
      return {
        verificationId: r.id,
        commandId: r.command_id,
        name: command.name,
        argv: command.argv,
        tree: r.tree,
        state: r.state,
        exitCode: r.exit_code,
        signal: r.signal,
        timedOut: r.timed_out === 1,
        durationMs: r.duration_ms,
        output: r.output_tail,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        stale: currentTree !== null && currentTree !== r.tree,
      };
    });
  }

  /** The worktree's tree now, without pinning it. */
  async currentTree(sessionId: string): Promise<string | null> {
    const row = this.worktree(sessionId);
    if (!row) return null;
    return this.lease(row.worktree_path, () => this.snapshotTree(row.worktree_path));
  }

  /** Starts an agreed check in the working copy; its result is recorded when it ends. */
  async verify(sessionId: string, projectId: string, commandId: string): Promise<string> {
    const binding = this.binding(projectId);
    const row = this.worktree(sessionId);
    if (!binding || !row) throw new WorkspaceError('TARGET_NOT_FOUND', 'no working copy to check');
    if (!binding.trusted)
      throw new WorkspaceError('CAPABILITY_DENIED', 'trust the repository before running checks');
    const command = (JSON.parse(binding.verify_json) as VerifyCommand[]).find(
      (c) => c.id === commandId,
    );
    if (!command) throw new WorkspaceError('TARGET_NOT_FOUND', 'no such check');
    const tree = await this.lease(row.worktree_path, () => this.snapshotTree(row.worktree_path));
    const id = `verify_${randomUUID().slice(0, 8)}`;
    const started = Date.now();
    this.db
      .prepare(
        `INSERT INTO verifications (id, session_id, command_id, command_json, tree, exit_code, signal,
           timed_out, duration_ms, output_tail, state, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, NULL, '', 'running', ?, NULL)`,
      )
      .run(id, sessionId, command.id, JSON.stringify(command), tree, this.clock.nowIso());
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
    };
    let timedOut = false;
    const finish = (code: number | null, signal: string | null, error?: string) => {
      this.db
        .prepare(
          `UPDATE verifications SET exit_code = ?, signal = ?, timed_out = ?, duration_ms = ?,
             output_tail = ?, state = ?, ended_at = ? WHERE id = ?`,
        )
        .run(
          code,
          signal,
          timedOut ? 1 : 0,
          Date.now() - started,
          error ? `${output}\n${error}`.slice(-OUTPUT_TAIL) : output,
          error ? 'error' : code === 0 && !timedOut ? 'passed' : 'failed',
          this.clock.nowIso(),
          id,
        );
    };
    try {
      const child = spawn(command.argv[0] as string, command.argv.slice(1), {
        cwd: row.worktree_path,
        shell: false,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '',
          LANG: process.env.LANG ?? 'C.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, command.timeoutMs);
      timer.unref();
      child.on('error', (error) => {
        clearTimeout(timer);
        finish(null, null, `could not start: ${error.message}`);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        finish(code, signal);
      });
    } catch (error) {
      finish(null, null, `could not start: ${String(error)}`);
    }
    return id;
  }

  // ── the file broker (FileTools) ─────────────────────────────────────────────

  private worktreeOfRun(runId: string): { row: WorktreeRow; sessionId: string } | null {
    const sessionId = this.sessionOfRun(runId);
    if (!sessionId) return null;
    const row = this.worktree(sessionId);
    return row ? { row, sessionId } : null;
  }

  available(runId: string): boolean {
    return this.worktreeOfRun(runId) !== null;
  }

  private lease<T>(worktree: string, work: () => Promise<T>): Promise<T> {
    const previous = this.leases.get(worktree) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.leases.set(
      worktree,
      next.catch(() => undefined),
    );
    return next;
  }

  private readsOf(runId: string, executionId: string) {
    const executions = this.reads.get(runId) ?? new Map<string, Map<string, string>>();
    this.reads.set(runId, executions);
    const map = executions.get(executionId) ?? new Map<string, string>();
    executions.set(executionId, map);
    return map;
  }

  async execute(
    input: {
      name: BrokerFileToolName;
      args: Record<string, unknown>;
      runId: string;
      executionId: string;
      toolCallId: string;
    },
    cancellation: ToolCancellation,
  ): Promise<Record<string, unknown>> {
    if (input.name === 'write') {
      const args = PiWriteInput.parse(input.args);
      return this.execute(
        { ...input, name: 'write_file', args: { path: args.path, text: args.content } },
        cancellation,
      );
    }
    const found = this.worktreeOfRun(input.runId);
    if (!found) throw new ToolRefusal('CAPABILITY_DENIED', 'this run has no working copy');
    const root = found.row.worktree_path;
    const reads = this.readsOf(input.runId, input.executionId);
    const name = input.name;
    switch (name) {
      case 'edit': {
        const args = PiEditInput.parse(input.args);
        return this.lease(root, async () => {
          const before = await this.requireRead(root, args.path, reads);
          const bytes = await readFile(join(root, args.path));
          if (bytes.length > MAX_TEXT)
            throw new ToolRefusal('LIMIT_REACHED', 'files are at most 1 MiB');
          if (sha256(bytes) !== before)
            throw new ToolRefusal('CAPABILITY_DENIED', `${args.path} changed since it was read`);
          const text = decodeText(bytes);
          if (text === null) throw new ToolRefusal('CAPABILITY_DENIED', 'edit requires UTF-8 text');
          if (cancellation.aborted)
            throw new ToolRefusal('TARGET_TERMINAL', 'the task was cancelled');
          const edited = await this.edit({ ...args, text }, cancellation).catch((error) => {
            if (error instanceof PiEditError)
              throw new ToolRefusal('SCHEMA_INVALID', error.message);
            throw error;
          });
          // Recheck the read hash under the same lease after the worker returns.
          const applied = await this.change(
            root,
            found.sessionId,
            { ...input, name: 'write_file', args: { path: args.path, text: edited.text } },
            reads,
            cancellation,
          );
          return { ...applied, piResult: edited.result };
        });
      }
      case 'list_files':
        return this.list(root, typeof input.args.path === 'string' ? input.args.path : '');
      case 'read_file': {
        const rel = safeRelative(String(input.args.path));
        const kind = await assertPlainPath(root, rel);
        if (kind !== 'file') throw new ToolRefusal('TARGET_NOT_FOUND', `${rel} is not a file`);
        const bytes = await readFile(join(root, rel));
        if (bytes.length > MAX_TEXT)
          throw new ToolRefusal('LIMIT_REACHED', `${rel} is larger than 1 MiB`);
        const text = decodeText(bytes);
        if (text === null) throw new ToolRefusal('CAPABILITY_DENIED', `${rel} is not UTF-8 text`);
        const hash = sha256(bytes);
        reads.set(rel, hash);
        return { path: rel, text, sha256: hash };
      }
      default:
        return this.lease(root, () =>
          this.change(root, found.sessionId, { ...input, name }, reads, cancellation),
        );
    }
  }

  private async list(root: string, folder: string, isGit = true) {
    const rel = folder ? safeRelative(folder) : '';
    if (rel) {
      await assertPlainPath(root, rel);
      if (!(await stat(join(root, rel))).isDirectory())
        throw new WorkspaceError('TARGET_NOT_FOUND', 'the folder is unavailable');
    }
    // Git's ignore rules keep dependencies and generated output out of the picker.
    const walk = isGit ? null : await this.folderPaths(root, rel);
    const out =
      walk?.paths ??
      (
        await git(root, [
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
          '--',
          rel ? `:(literal)${rel}` : '.',
        ])
      ).stdout
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
    const files: { path: string; bytes: number }[] = [];
    for (const path of [...new Set(out)].slice(0, 500)) {
      try {
        safeRelative(path);
        if ((await assertPlainPath(root, path)) !== 'file') continue;
        const info = await lstat(join(root, path));
        if (info.isFile()) files.push({ path, bytes: info.size });
      } catch {
        // Listed by git but already gone: not a file now.
      }
    }
    return { files, truncated: !!walk?.truncated || out.length > 500 };
  }

  /** Non-Git folders have the same bounded picker and never follow directory symlinks. */
  private async folderPaths(root: string, folder: string) {
    const pending = [folder];
    const paths: string[] = [];
    let visited = 0;
    while (pending.length && paths.length <= 500 && visited < 2000) {
      const rel = pending.shift() as string;
      const dir = await opendir(join(root, rel));
      for await (const entry of dir) {
        if (++visited >= 2000) break;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        try {
          safeRelative(path);
        } catch {
          continue;
        }
        if (entry.isDirectory()) pending.push(path);
        if (entry.isFile()) paths.push(path);
        if (paths.length > 500) break;
      }
    }
    return { paths, truncated: pending.length > 0 || visited >= 2000 || paths.length > 500 };
  }

  /** What an existing file must look like before it may be changed: as this run read it. */
  private async requireRead(root: string, rel: string, reads: Map<string, string>) {
    const current = sha256(await readFile(join(root, rel)));
    const read = reads.get(rel);
    if (!read) throw new ToolRefusal('REVISION_CONFLICT', `read ${rel} before changing it`);
    if (read !== current)
      throw new ToolRefusal('REVISION_CONFLICT', `${rel} changed since you read it; read it again`);
    return current;
  }

  private async change(
    root: string,
    sessionId: string,
    input: {
      name: 'list_files' | 'read_file' | 'write_file' | 'delete_file' | 'move_file';
      args: Record<string, unknown>;
      runId: string;
      executionId: string;
      toolCallId: string;
    },
    reads: Map<string, string>,
    cancellation: ToolCancellation,
  ): Promise<Record<string, unknown>> {
    const now = () => this.clock.nowIso();
    const opId = `fileop_${randomUUID().slice(0, 12)}`;
    const plan = (
      kind: 'write' | 'delete' | 'move',
      path: string,
      toPath: string | null,
      before: string | null,
      after: string | null,
    ) =>
      this.db
        .prepare(
          `INSERT INTO file_operations (id, session_id, run_id, execution_id, tool_call_id, kind,
             path, to_path, before_hash, after_hash, state, detail, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, ?)`,
        )
        .run(
          opId,
          sessionId,
          input.runId,
          input.executionId,
          input.toolCallId,
          kind,
          path,
          toPath,
          before,
          after,
          now(),
          now(),
        );
    const settle = (state: 'applied' | 'failed', detail: string | null = null) =>
      this.db
        .prepare('UPDATE file_operations SET state = ?, detail = ?, updated_at = ? WHERE id = ?')
        .run(state, detail, now(), opId);
    const guard = () => {
      if (cancellation.aborted) throw new ToolRefusal('TARGET_TERMINAL', 'the task was cancelled');
    };

    if (input.name === 'write_file') {
      const rel = safeRelative(String(input.args.path));
      const text = String(input.args.text ?? '');
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length > MAX_TEXT)
        throw new ToolRefusal('LIMIT_REACHED', 'files are at most 1 MiB');
      const kind = await assertPlainPath(root, rel);
      if (kind === 'other')
        throw new ToolRefusal('CAPABILITY_DENIED', `${rel} is not a plain file`);
      const before = kind === 'file' ? await this.requireRead(root, rel, reads) : null;
      const after = sha256(bytes);
      guard();
      plan('write', rel, null, before, after);
      try {
        const full = join(root, rel);
        await mkdir(dirname(full), { recursive: true });
        if ((await assertPlainPath(root, rel)) === 'other')
          throw new Error('the path changed while writing');
        const mode = kind === 'file' ? (await stat(full)).mode : 0o644;
        const temporary = join(
          dirname(full),
          `.${basename(full)}.corral-${randomUUID().slice(0, 8)}`,
        );
        await writeFile(temporary, bytes, { mode });
        await rename(temporary, full);
        settle('applied');
      } catch (error) {
        settle('failed', String(error instanceof Error ? error.message : error).slice(0, 200));
        throw new ToolRefusal('CAPABILITY_DENIED', `could not write ${rel}`);
      }
      reads.set(rel, after);
      return { path: rel, sha256: after, bytes: bytes.length, created: kind === 'missing' };
    }

    if (input.name === 'delete_file') {
      const rel = safeRelative(String(input.args.path));
      if ((await assertPlainPath(root, rel)) !== 'file')
        throw new ToolRefusal('TARGET_NOT_FOUND', `${rel} is not a file`);
      const before = await this.requireRead(root, rel, reads);
      guard();
      plan('delete', rel, null, before, null);
      try {
        await unlink(join(root, rel));
        settle('applied');
      } catch (error) {
        settle('failed', String(error).slice(0, 200));
        throw new ToolRefusal('CAPABILITY_DENIED', `could not delete ${rel}`);
      }
      reads.delete(rel);
      return { path: rel, deleted: true };
    }

    const from = safeRelative(String(input.args.from));
    const to = safeRelative(String(input.args.to));
    if ((await assertPlainPath(root, from)) !== 'file')
      throw new ToolRefusal('TARGET_NOT_FOUND', `${from} is not a file`);
    if ((await assertPlainPath(root, to)) !== 'missing')
      throw new ToolRefusal('REVISION_CONFLICT', `${to} already exists`);
    const before = await this.requireRead(root, from, reads);
    guard();
    plan('move', from, to, before, before);
    try {
      await mkdir(dirname(join(root, to)), { recursive: true });
      await rename(join(root, from), join(root, to));
      settle('applied');
    } catch (error) {
      settle('failed', String(error).slice(0, 200));
      throw new ToolRefusal('CAPABILITY_DENIED', `could not move ${from}`);
    }
    reads.delete(from);
    reads.set(to, before);
    return { from, to, moved: true };
  }

  // ── helpers for review and integration (CR-013) ─────────────────────────────

  /** The session's working copy and the folder it came from, for the review service. */
  copyOf(sessionId: string): {
    worktree: string;
    root: string;
    baseTree: string;
    reviewedAt: string | null;
  } | null {
    const row = this.worktree(sessionId) as (WorktreeRow & { reviewed_at?: string | null }) | null;
    if (!row) return null;
    const binding = this.db
      .prepare('SELECT * FROM workspace_bindings WHERE id = ?')
      .get(row.binding_id) as BindingRow | undefined;
    if (!binding) return null;
    return {
      worktree: row.worktree_path,
      root: binding.root_path,
      baseTree: row.base_tree,
      reviewedAt: row.reviewed_at ?? null,
    };
  }

  /** Paths that differ between two trees, with what happened to each. */
  async changedPaths(worktree: string, from: string, to: string) {
    const raw = (
      await git(worktree, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to])
    ).stdout
      .toString('utf8')
      .split('\0');
    const out: { path: string; status: string }[] = [];
    for (let i = 0; i < raw.length - 1; i += 2) {
      if (raw[i] && raw[i + 1])
        out.push({ status: (raw[i] as string)[0] as string, path: raw[i + 1] as string });
    }
    return out;
  }

  /** A file's bytes in a tree, or null when the tree has no such file. */
  async blob(worktree: string, tree: string, path: string): Promise<Buffer | null> {
    try {
      const sha = await gitText(worktree, ['rev-parse', '--verify', '--quiet', `${tree}:${path}`]);
      return (await git(worktree, ['cat-file', 'blob', sha])).stdout;
    } catch {
      return null;
    }
  }

  /** The working copy's tree now, pinned as the session's latest. */
  async latestTree(sessionId: string): Promise<string | null> {
    const row = this.worktree(sessionId);
    if (!row) return null;
    const tree = await this.lease(row.worktree_path, () => this.snapshotTree(row.worktree_path));
    await this.pin(row.worktree_path, `refs/corral/${sessionId}/latest`, tree);
    return tree;
  }

  fileOperations(sessionId: string) {
    return this.db
      .prepare(
        `SELECT id, run_id, execution_id, kind, path, to_path, state, detail, created_at
         FROM file_operations WHERE session_id = ? ORDER BY created_at DESC LIMIT 500`,
      )
      .all(sessionId) as {
      id: string;
      run_id: string;
      execution_id: string;
      kind: string;
      path: string;
      to_path: string | null;
      state: string;
      detail: string | null;
      created_at: string;
    }[];
  }
}

export { GitError };
