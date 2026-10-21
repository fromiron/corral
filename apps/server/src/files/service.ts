import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, realpathSync } from 'node:fs';
import {
  chmod,
  link,
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { editText, PiEditError } from '@corral/adapter-pi';
import {
  type BrokerFileToolName,
  CaptureCheckpoint,
  type CheckExecution,
  CheckPlan,
  CheckpointManifest,
  type CheckpointRestore,
  type CheckpointRestorePlan,
  type Clock,
  type CommandExecution,
  CommandPlan,
  CommandReport,
  canonicalJson,
  DocumentCommand,
  type DocumentMutationIntent,
  type DocumentOperation,
  type EditTextRequest,
  type EditTextResult,
  type FileCheckpoint,
  type FileDocument,
  HashlineEditInput,
  HunkPlanRequest,
  HunkRequest,
  type HunkSet,
  type LspExecution,
  LspProposal,
  LspProposalContent,
  LspProposalSummary,
  LspQuery,
  LspReport,
  PiEditInput,
  PiWriteInput,
  ProjectToolConfig,
  type RegisteredCheck,
  type RegisteredMcpServer,
  RestoreCheckpoint,
  ReviewRecipeRevision,
  RunCommandArgs,
  type Scheduler,
  type TerminalCreate,
  type VerificationOwner,
  VerificationReport,
  type WorkspaceTarget,
} from '@corral/contracts';
import {
  type FileTools,
  rankFuzzy,
  type ToolCancellation,
  ToolRefusal,
  ToolTerminationUnconfirmed,
} from '@corral/core';
import { type Db, SqliteHarnessStore, SqliteProjectToolStore } from '@corral/storage-sqlite';
import { PtyRuntime, type PtyRuntimeOptions } from '../processes/pty.ts';
import { CommandCapacityError, CommandRuntime } from '../processes/runtime.ts';
import { commandEnvironment, listShells, resolveShellCommand } from '../processes/shells.ts';
import { systemTimers } from '../runtime.ts';
import { isolatedChecksAvailable } from './check-isolation.ts';
import { redactToolText } from './check-output.ts';
import { checkGitEnvironment, GitError, git, gitText } from './git.ts';
import {
  applyHashline,
  HashlineError,
  type HashlineEvidence,
  type HashlineScope,
  mergeHashlineEvidence,
  readHashline,
} from './hashline.ts';
import { checkLaunchFingerprint, launchFingerprint } from './launch-fingerprint.ts';
import { LspRunner } from './lsp.ts';
import { stageLspEdit } from './lsp-edits.ts';
import { lspResults, validateLspPosition } from './lsp-results.ts';
import { RunAccessStore } from './run-access.ts';
import { VerificationRunner } from './verification.ts';
import { WorkbenchOperations } from './workbench-operations.ts';
import { WorkspaceAccessStore } from './workspace-access.ts';

// Work folders and file changes (CR-012). A project may link one folder, which is only
// observed. A session gets its own git worktree outside that folder; agents change files
// there only through the broker below, which records what it is about to do before doing it.
// Snapshots are git trees written from a temporary index, pinned under refs/corral/.

const MAX_TEXT = 1024 * 1024;

export type VerifyCommand = RegisteredCheck;

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
  bindingId: string;
  copyGeneration: number;
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
  report: VerificationReport | null;
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

function decodeText(bytes: Buffer, preserveBom = false): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBom }).decode(bytes);
  } catch {
    return null;
  }
}

/** Bounded bytes only; human reads never update an execution's evidence ledger. */
async function boundedFile(
  root: string,
  rel: string,
): Promise<{ bytes: Buffer | null; size: number }> {
  if ((await assertPlainPath(root, rel)) !== 'file')
    throw new ToolRefusal('TARGET_NOT_FOUND', `${rel} is not a file`);
  const handle = await open(join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (await realpath(join(root, rel))) !== resolve(root, rel))
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'only plain files in the working copy can be read',
      );
    const current = await lstat(join(root, rel));
    if (current.ino !== info.ino || current.dev !== info.dev)
      throw new ToolRefusal('REVISION_CONFLICT', `${rel} changed while opening`);
    if (info.size > MAX_TEXT) return { bytes: null, size: info.size };
    const buffer = Buffer.alloc(MAX_TEXT + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new ToolRefusal('REVISION_CONFLICT', `${rel} changed while reading`);
    return { bytes: size > MAX_TEXT ? null : buffer.subarray(0, size), size };
  } finally {
    await handle.close();
  }
}

async function textBytes(root: string, rel: string) {
  const { bytes } = await boundedFile(root, rel);
  if (!bytes) throw new ToolRefusal('LIMIT_REACHED', `${rel} is larger than 1 MiB`);
  return bytes;
}

async function expectFile(root: string, rel: string, expected: string | null) {
  const kind = await assertPlainPath(root, rel);
  if (
    expected === null
      ? kind === 'missing'
      : kind === 'file' && sha256(await textBytes(root, rel)) === expected
  )
    return;
  throw new ToolRefusal('REVISION_CONFLICT', `${rel} changed since the operation was prepared`);
}

type MutationIo = {
  writeFile: typeof writeFile;
  rename: typeof rename;
  unlink: typeof unlink;
  link: typeof link;
};

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
  copy_generation: number;
  worktree_path: string;
  base_commit: string;
  base_tree: string;
  reviewed_tree: string | null;
  created_at: string;
  removed_at: string | null;
}

export class WorkspaceService implements FileTools {
  readonly terminals: PtyRuntime;
  private readonly commandRuntime = new CommandRuntime();
  private readonly pendingCommands = new Map<string, Promise<CommandReport>>();
  private readonly pendingCommandHashes = new Map<string, string>();
  private readonly commandServices = new Map<
    string,
    { runId: string; started: Promise<boolean>; completion: Promise<CommandReport> }
  >();
  private readonly commandEpochs = new Map<string, number>();
  private readonly pendingCommandRuns = new Map<string, string>();
  private disposing = false;
  private readonly runAccess: RunAccessStore;
  private readonly workspaceAccess: WorkspaceAccessStore;
  private readonly workbenchOperations: WorkbenchOperations;
  private readonly removingWorktrees = new Set<string>();
  private readonly preparingRuns = new Map<string, Promise<void>>();
  private readonly criteria = new Map<string, ReviewRecipeRevision['criteriaFiles']>();
  private readonly lsp: Pick<LspRunner, 'query'>;
  private readonly io: MutationIo;
  readonly projectTools: SqliteProjectToolStore;
  private readonly verificationRunner: VerificationRunner;
  private readonly newVerificationId: () => string;
  private readonly newLspProposalId: () => string;
  private readonly checks = new Map<
    string,
    { sessionId: string; cancel: () => void; completion: Promise<VerificationReport> }
  >();
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly worktreeRoot: string;
  private readonly hostId: string;
  /** Folders that may never be linked: Corral's own data and credentials. */
  private readonly forbidden: string[];
  /** Per-worktree write lease: one Corral write at a time (WB-WSP-003). */
  private readonly leases = new Map<string, Promise<unknown>>();
  private readonly pendingSnapshots = new Map<string, Promise<string | null>>();
  /** Run → execution → path hash: another attempt's read never authorizes an overwrite. */
  private readonly reads = new Map<string, Map<string, Map<string, string>>>();
  private readonly hashlineReads = new Map<string, Map<string, HashlineEvidence>>();
  private readonly edit: (
    request: EditTextRequest,
    cancellation: ToolCancellation,
  ) => Promise<EditTextResult>;

  constructor(options: {
    db: Db;
    clock: Clock;
    worktreeRoot: string;
    forbidden: string[];
    hostId?: string;
    timers?: Scheduler;
    newVerificationId?: () => string;
    newLspProposalId?: () => string;
    io?: Partial<MutationIo>;
    pty?: Pick<PtyRuntimeOptions, 'spawn' | 'capture' | 'cleanup' | 'shells' | 'newGeneration'>;
    lsp?: Pick<LspRunner, 'query'>;
    edit?: (request: EditTextRequest, cancellation: ToolCancellation) => Promise<EditTextResult>;
  }) {
    this.db = options.db;
    this.hostId = options.hostId ?? 'local';
    this.runAccess = new RunAccessStore(this.db);
    this.workspaceAccess = new WorkspaceAccessStore(this.db);
    this.workbenchOperations = new WorkbenchOperations(this.db, options.clock);
    this.workbenchOperations.recover();
    this.db
      .prepare(`UPDATE checkpoint_restores SET result_json=json_set(result_json, '$.state', 'uncertain')
      WHERE json_extract(result_json, '$.state')='applying'`)
      .run();
    this.io = { writeFile, rename, unlink, link, ...options.io };
    this.clock = options.clock;
    this.db
      .prepare("UPDATE command_operations SET state='uncertain',updated_at=? WHERE state='running'")
      .run(this.clock.nowIso());
    this.projectTools = new SqliteProjectToolStore(options.db, options.clock);
    this.lsp =
      options.lsp ??
      new LspRunner({ clock: options.clock, timers: options.timers ?? systemTimers });
    this.verificationRunner = new VerificationRunner({
      clock: options.clock,
      timers: options.timers ?? systemTimers,
    });
    this.newVerificationId =
      options.newVerificationId ?? (() => `verify_${randomUUID().replaceAll('-', '')}`);
    this.newLspProposalId =
      options.newLspProposalId ?? (() => `lsp_${randomUUID().replaceAll('-', '')}`);
    this.edit = options.edit ?? ((request, cancellation) => editText(request, { cancellation }));
    this.worktreeRoot = resolve(options.worktreeRoot);
    this.forbidden = [...options.forbidden, this.worktreeRoot].map((p) => resolve(p));
    this.terminals = new PtyRuntime({
      ...options.pty,
      operations: this.workbenchOperations,
      timers: options.timers,
      target: (sessionId, expected) => {
        const current = this.documentTarget(sessionId, expected, Boolean(expected));
        return {
          target: current.target,
          path: current.row.worktree_path,
          writable:
            Boolean(current.binding.trusted) &&
            !this.disposing &&
            !this.removingWorktrees.has(sessionId),
        };
      },
      prepare: (input) => this.prepareTerminal(input),
    });
    // A write planned before the last stop has an unknown outcome; it is never redone (WB-WSP-005).
    this.db
      .prepare(
        `UPDATE file_operations SET state = 'uncertain', updated_at = ?,
           detail = 'the server stopped between planning and finishing this write'
         WHERE state = 'planned'`,
      )
      .run(this.clock.nowIso());
    const interrupted = this.db
      .prepare("SELECT id,session_id FROM lsp_proposals WHERE state='applying'")
      .all() as { id: string; session_id: string }[];
    for (const row of interrupted) {
      const proposal = this.lspProposal(row.session_id, row.id);
      const outcomes = proposal.files.map((file) => {
        const operation = this.db
          .prepare('SELECT state FROM file_operations WHERE tool_call_id=? AND path=?')
          .get(row.id, file.path) as { state: string } | undefined;
        const state =
          operation?.state === 'applied'
            ? ('applied' as const)
            : operation?.state === 'failed'
              ? ('failed' as const)
              : operation
                ? ('uncertain' as const)
                : ('pending' as const);
        return { path: file.path, state };
      });
      this.settleLspProposal(proposal, 'partial', outcomes);
    }
    this.db
      .prepare(
        `UPDATE verifications SET state = 'error', ended_at = ?,
           output_tail = output_tail || '\n[the server stopped during this check]',
           report_json = CASE WHEN report_json IS NULL THEN NULL ELSE json_set(report_json, '$.state', 'error', '$.verdict', 'inconclusive', '$.cleanupConfirmed', json('false'), '$.endedAt', ?) END
         WHERE state = 'running'`,
      )
      .run(this.clock.nowIso(), this.clock.nowIso());
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
      verifyCommands: this.projectTools.latest(projectId)?.checks ?? [],
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
    this.db.transaction(() => {
      if (change.verifyCommands) {
        const previous = this.projectTools.latest(projectId);
        this.projectTools.save(projectId, previous?.revision ?? 0, {
          checks: change.verifyCommands,
          lspServers: previous?.lspServers ?? [],
          ...(previous?.mcpServers ? { mcpServers: previous.mcpServers } : {}),
        });
      }
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
    })();
    return (await this.view(projectId)) as BindingView;
  }

  // ── session worktrees ───────────────────────────────────────────────────────

  validateProjectTools(projectId: string, expectedRevision: number, raw: ProjectToolConfig) {
    const binding = this.binding(projectId);
    if (!binding?.trusted)
      throw new WorkspaceError(
        'CAPABILITY_DENIED',
        'trust the repository before configuring tools',
      );
    const config = ProjectToolConfig.parse(raw);
    const prior = this.projectTools.latest(projectId);
    if ((prior?.revision ?? 0) !== expectedRevision)
      throw new WorkspaceError('REVISION_CONFLICT', 'project tool revision changed');
    const removed = (prior?.mcpServers ?? []).filter(
      (server) => !config.mcpServers?.some((next) => next.id === server.id),
    );
    if (removed.some((server) => this.mcpUsages(projectId, server.id).length))
      throw new WorkspaceError(
        'CAPABILITY_DENIED',
        'Remove this MCP server from the settings that use it first.',
      );
    for (const server of config.mcpServers ?? []) {
      const old = prior?.mcpServers?.find((item) => item.id === server.id);
      if (!old) {
        const historic = this.projectTools
          .history(projectId)
          .flatMap((revision) => revision.mcpServers ?? [])
          .find((item) => item.id === server.id);
        if (
          historic &&
          canonicalJson({ ...historic, enabled: false }) !==
            canonicalJson({ ...server, enabled: false })
        )
          throw new WorkspaceError(
            'SCHEMA_INVALID',
            'MCP server ID was already used; create a new server.',
          );
      }
      if (
        server.transport === 'http' &&
        server.auth.kind !== 'none' &&
        old?.transport === 'http' &&
        old.auth.kind !== 'none'
      ) {
        const { credentialRef: _oldRef, ...oldAuth } = old.auth;
        const { credentialRef: _newRef, ...newAuth } = server.auth;
        if (
          old.auth.credentialRef === server.auth.credentialRef &&
          (old.url !== server.url || canonicalJson(oldAuth) !== canonicalJson(newAuth))
        )
          server.auth.credentialRef = `credential_${randomUUID()}`;
      }
    }
    return config;
  }

  configureProjectTools(projectId: string, expectedRevision: number, raw: ProjectToolConfig) {
    return this.db.transaction(() => {
      const config = this.validateProjectTools(projectId, expectedRevision, raw);
      const binding = this.binding(projectId);
      if (!binding) throw new WorkspaceError('TARGET_NOT_FOUND', 'workspace binding missing');
      const saved = this.projectTools.save(projectId, expectedRevision, config);
      this.db
        .prepare('UPDATE workspace_bindings SET verify_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(saved.checks), this.clock.nowIso(), binding.id);
      return saved;
    })();
  }

  mcpUsages(projectId: string, serverId: string) {
    const harnesses = new SqliteHarnessStore(this.db, this.clock);
    return harnesses
      .currentBindings(projectId)
      .filter((item) => harnesses.getProfile(item.binding)?.mcpServerIds?.includes(serverId));
  }

  async criteriaFiles(
    projectId: string,
    paths: string[],
  ): Promise<ReviewRecipeRevision['criteriaFiles']> {
    const binding = this.binding(projectId);
    if (!binding?.trusted)
      throw new WorkspaceError(
        'CAPABILITY_DENIED',
        'trust the repository before configuring tools',
      );
    const files: ReviewRecipeRevision['criteriaFiles'] = [];
    for (const path of paths)
      files.push({
        path: safeRelative(path),
        sha256: sha256(await textBytes(binding.root_path, safeRelative(path))),
      });
    return ReviewRecipeRevision.shape.criteriaFiles.parse(files);
  }

  async inspectProjectTool(projectId: string, kind: 'check' | 'lsp', commandId: string) {
    const binding = this.binding(projectId);
    if (!binding?.trusted)
      throw new WorkspaceError('CAPABILITY_DENIED', 'trust the repository before inspecting tools');
    const config = this.projectTools.latest(projectId);
    const command = (kind === 'check' ? config?.checks : config?.lspServers)?.find(
      (tool) => tool.id === commandId,
    );
    if (!config || !command)
      throw new WorkspaceError('TARGET_NOT_FOUND', 'no such registered tool');
    const { fingerprint } = await launchFingerprint(binding.root_path, config.revision, command);
    return {
      command,
      configRevision: config.revision,
      fingerprint,
      trustedAt: this.projectTools.trust({ projectId, kind, id: commandId, fingerprint }),
    };
  }

  private async mcpFingerprint(root: string, revision: number, server: RegisteredMcpServer) {
    return server.transport === 'stdio'
      ? (
          await launchFingerprint(
            root,
            revision,
            server,
            server.browser ? [server.browser.executablePath] : [],
          )
        ).fingerprint
      : sha256(Buffer.from(canonicalJson({ revision, server })));
  }

  async inspectMcpServer(projectId: string, serverId: string, revision?: number) {
    const binding = this.binding(projectId);
    if (!binding?.trusted)
      throw new WorkspaceError('CAPABILITY_DENIED', 'trust the repository before inspecting tools');
    const config =
      revision === undefined
        ? this.projectTools.latest(projectId)
        : this.projectTools.get(projectId, revision);
    const server = config?.mcpServers?.find((server) => server.id === serverId);
    if (!config || !server) throw new WorkspaceError('TARGET_NOT_FOUND', 'no such registered tool');
    const fingerprint = await this.mcpFingerprint(binding.root_path, config.revision, server);
    return {
      server,
      configRevision: config.revision,
      fingerprint,
      trustedAt: this.projectTools.trust({ projectId, kind: 'mcp', id: serverId, fingerprint }),
    };
  }

  async mcpProbeContext(projectId: string, serverId: string, revision: number, sessionId?: string) {
    const inspected = await this.inspectMcpServer(projectId, serverId, revision);
    if (this.projectTools.latest(projectId)?.revision !== revision)
      throw new WorkspaceError('REVISION_CONFLICT', 'project tool revision changed');
    if (inspected.server.transport === 'http')
      return { ...inspected, cwd: undefined, copyIdentity: null };
    const row = sessionId ? this.worktree(sessionId) : null;
    const session = sessionId
      ? (this.db.prepare('SELECT project_id FROM work_sessions WHERE id = ?').get(sessionId) as
          | { project_id: string }
          | undefined)
      : null;
    const binding = this.binding(projectId);
    if (
      !row ||
      session?.project_id !== projectId ||
      !binding?.trusted ||
      row.binding_id !== binding.id
    )
      throw new WorkspaceError(
        'CAPABILITY_DENIED',
        'Choose an existing session working copy to test this server.',
      );
    const identity = await stat(row.worktree_path);
    const fingerprint = await this.mcpFingerprint(row.worktree_path, revision, inspected.server);
    return {
      ...inspected,
      fingerprint,
      trustedAt: this.projectTools.trust({ projectId, kind: 'mcp', id: serverId, fingerprint }),
      cwd: row.worktree_path,
      copyIdentity: sha256(
        Buffer.from(
          canonicalJson({ sessionId, binding: binding.id, dev: identity.dev, ino: identity.ino }),
        ),
      ),
    };
  }

  async trustMcpServer(
    projectId: string,
    serverId: string,
    fingerprint: string,
    trusted: boolean,
    sessionId?: string,
  ) {
    if (trusted) {
      const inspected = sessionId
        ? await this.mcpProbeContext(
            projectId,
            serverId,
            this.projectTools.latest(projectId)?.revision ?? 0,
            sessionId,
          )
        : await this.inspectMcpServer(projectId, serverId);
      if (
        inspected.fingerprint !== fingerprint ||
        this.projectTools.latest(projectId)?.revision !== inspected.configRevision
      )
        throw new WorkspaceError('REVISION_CONFLICT', 'launch fingerprint changed');
    }
    const target = { projectId, kind: 'mcp' as const, id: serverId, fingerprint };
    this.projectTools.setTrust(target, trusted);
    return { fingerprint, trustedAt: this.projectTools.trust(target) };
  }

  async runtimeMcp(runId: string, selection: CheckExecution['selection']) {
    const { row, config } = this.projectToolContext({ runId, selection });
    const servers: { server: RegisteredMcpServer; fingerprint: string }[] = [];
    for (const id of selection.mcpServerIds ?? []) {
      const server = config.mcpServers?.find((server) => server.id === id);
      if (!server || server.enabled === false)
        throw new ToolRefusal('CAPABILITY_DENIED', 'MCP server is not selected');
      const fingerprint = await this.mcpFingerprint(row.worktree_path, config.revision, server);
      if (
        !this.projectTools.trust({ projectId: selection.projectId, kind: 'mcp', id, fingerprint })
      )
        throw new ToolRefusal('CAPABILITY_DENIED', 'MCP launch requires current fingerprint trust');
      servers.push({ server, fingerprint });
    }
    return { cwd: row.worktree_path, servers };
  }

  workingDirectoryForRun(runId: string): string | null {
    const found = this.worktreeOfRun(runId);
    if (!found) return null;
    const session = this.db
      .prepare('SELECT project_id FROM work_sessions WHERE id = ?')
      .get(found.sessionId) as { project_id: string } | undefined;
    const binding = session ? this.binding(session.project_id) : null;
    if (
      !binding?.trusted ||
      binding.id !== found.row.binding_id ||
      !existsSync(found.row.worktree_path)
    )
      throw new ToolRefusal('CAPABILITY_DENIED', 'trusted working copy unavailable');
    return found.row.worktree_path;
  }

  async trustProjectTool(
    projectId: string,
    kind: 'check' | 'lsp',
    commandId: string,
    fingerprint: string,
    trusted: boolean,
  ) {
    if (trusted) {
      const inspected = await this.inspectProjectTool(projectId, kind, commandId);
      if (
        inspected.fingerprint !== fingerprint ||
        this.projectTools.latest(projectId)?.revision !== inspected.configRevision
      )
        throw new WorkspaceError('REVISION_CONFLICT', 'launch fingerprint changed');
    }
    const target = { projectId, kind, id: commandId, fingerprint };
    this.projectTools.setTrust(target, trusted);
    return { fingerprint, trustedAt: this.projectTools.trust(target) };
  }

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
          bindingId: row.binding_id,
          copyGeneration: row.copy_generation,
          baseCommit: row.base_commit,
          createdAt: row.created_at,
          removedAt: row.removed_at,
          reviewed: row.reviewed_tree !== null,
          missing: !existsSync(row.worktree_path),
        }
      : null;
  }

  async resolvePreviewRoot(sessionId: string): Promise<string> {
    const row = this.worktree(sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    const binding = this.db
      .prepare('SELECT trusted FROM workspace_bindings WHERE id=?')
      .get(row.binding_id) as { trusted: number } | undefined;
    if (!binding?.trusted)
      throw new WorkspaceError('CAPABILITY_DENIED', 'trust the project before opening previews');
    const root = await realpath(row.worktree_path);
    if ((await lstat(row.worktree_path)).isSymbolicLink() || root !== resolve(row.worktree_path))
      throw new WorkspaceError('CAPABILITY_DENIED', 'the working copy identity changed');
    const relativeRoot = relative(this.worktreeRoot, root);
    if (!relativeRoot || relativeRoot.startsWith('..') || isAbsolute(relativeRoot))
      throw new WorkspaceError('CAPABILITY_DENIED', 'the working copy identity changed');
    return root;
  }

  async createWorktree(
    sessionId: string,
    projectId: string,
    baseCommit?: string,
  ): Promise<WorktreeView> {
    if (baseCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit))
      throw new WorkspaceError('SCHEMA_INVALID', 'a full commit hash is required');
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
      head = await gitText(binding.root_path, [
        'rev-parse',
        '--verify',
        `${baseCommit ?? 'HEAD'}^{commit}`,
      ]);
    } catch {
      throw new WorkspaceError(
        'SCHEMA_INVALID',
        'the repository does not contain the requested commit',
      );
    }
    const path = join(this.worktreeRoot, binding.id, sessionId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await git(binding.root_path, ['worktree', 'add', '--detach', path, head]);
    const tree = await gitText(path, ['rev-parse', `${head}^{tree}`]);
    await this.pin(path, `refs/corral/${sessionId}/base`, tree);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_worktrees (session_id, binding_id, worktree_path,
           base_commit, base_tree, reviewed_tree, created_at, removed_at, copy_generation)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL,
           COALESCE((SELECT copy_generation+1 FROM session_worktrees WHERE session_id=?),1))`,
      )
      .run(sessionId, binding.id, path, head, tree, this.clock.nowIso(), sessionId);
    return this.worktreeView(sessionId) as WorktreeView;
  }

  /** Removes the working copy (its files only); the original folder is not touched. */
  async removeWorktree(sessionId: string) {
    const row = this.worktree(sessionId);
    if (!row) return;
    if (this.removingWorktrees.has(sessionId))
      throw new WorkspaceError('REVISION_CONFLICT', 'the working copy is being removed');
    const binding = this.db
      .prepare('SELECT * FROM workspace_bindings WHERE id = ?')
      .get(row.binding_id) as BindingRow | undefined;
    this.removingWorktrees.add(sessionId);
    try {
      await this.lease(row.worktree_path, async () => {
        const path = existsSync(row.worktree_path)
          ? realpathSync.native(row.worktree_path)
          : resolve(row.worktree_path);
        const key = process.platform === 'win32' ? path.toLowerCase() : path;
        if (this.workspaceAccess.ownersAt(key).length)
          throw new WorkspaceError(
            'REVISION_CONFLICT',
            'working copy access has active or uncertain owners',
          );
        if (binding) {
          await git(binding.root_path, ['worktree', 'remove', '--force', row.worktree_path]).catch(
            () => rm(row.worktree_path, { recursive: true, force: true }),
          );
          await git(binding.root_path, ['worktree', 'prune']).catch(() => undefined);
        }
        this.db
          .prepare('UPDATE session_worktrees SET removed_at = ? WHERE session_id = ?')
          .run(this.clock.nowIso(), sessionId);
      });
    } finally {
      this.removingWorktrees.delete(sessionId);
    }
  }

  private documentTarget(sessionId: string, expected?: WorkspaceTarget, write = false) {
    const row = this.worktree(sessionId);
    const session = this.db
      .prepare('SELECT project_id FROM work_sessions WHERE id=?')
      .get(sessionId) as { project_id: string } | undefined;
    if (!row || !session)
      throw new WorkspaceError('TARGET_NOT_FOUND', 'the working copy is unavailable');
    const binding = this.binding(session.project_id);
    if (!binding || binding.id !== row.binding_id)
      throw new WorkspaceError('REVISION_CONFLICT', 'the working copy binding changed');
    const target: WorkspaceTarget = {
      hostId: this.hostId,
      projectId: session.project_id,
      bindingId: row.binding_id,
      sessionId,
      copyGeneration: row.copy_generation,
    };
    if (expected && canonicalJson(expected) !== canonicalJson(target))
      throw new WorkspaceError('REVISION_CONFLICT', 'the document target changed');
    if (write) {
      if (this.disposing || this.removingWorktrees.has(sessionId))
        throw new ToolRefusal('TARGET_TERMINAL', 'the working copy is closing or being removed');
      if (!binding.trusted)
        throw new WorkspaceError('CAPABILITY_DENIED', 'trust the repository before changing files');
    }
    return { row, binding, target };
  }

  private async prepareTerminal(input: TerminalCreate): Promise<string> {
    const { row } = this.documentTarget(input.target.sessionId, input.target, true);
    return this.lease(row.worktree_path, async () => {
      this.documentTarget(input.target.sessionId, input.target, true);
      const directory = await realpath(row.worktree_path);
      if (directory !== resolve(row.worktree_path))
        throw new WorkspaceError('REVISION_CONFLICT', 'the working copy identity changed');
      const tree = await this.snapshotTree(directory);
      await this.pin(
        directory,
        `refs/corral/${input.target.sessionId}/terminals/${input.operationId}/start`,
        tree,
      );
      this.workspaceAccess.pin({ kind: 'user', id: input.operationId }, tree);
      return directory;
    });
  }

  async readDocument(sessionId: string, input: string): Promise<FileDocument> {
    const path = safeRelative(input);
    const { row, target } = this.documentTarget(sessionId);
    return this.lease(row.worktree_path, async () => {
      const current = this.documentTarget(sessionId, target);
      if ((await realpath(row.worktree_path)) !== resolve(row.worktree_path))
        throw new WorkspaceError('REVISION_CONFLICT', 'the working copy identity changed');
      const writable =
        Boolean(current.binding.trusted) &&
        !this.disposing &&
        !this.removingWorktrees.has(sessionId) &&
        !this.hasUnsafeWorktreeOwner(sessionId);
      const kind = await assertPlainPath(row.worktree_path, path);
      if (kind === 'missing')
        return { target, path, content: { kind: 'absent' }, version: null, writable };
      if (kind !== 'file')
        throw new WorkspaceError('CAPABILITY_DENIED', 'documents must be plain files');
      const { bytes, size } = await boundedFile(row.worktree_path, path);
      if (!bytes)
        return {
          target,
          path,
          content: { kind: 'too_large', bytes: size },
          version: null,
          writable: false,
        };
      const text = decodeText(bytes, true);
      if (text === null)
        return {
          target,
          path,
          content: { kind: 'binary', bytes: size },
          version: null,
          writable: false,
        };
      const endings = new Set(
        (text.match(/\r\n|\r|\n/g) ?? []).map((ending) =>
          ending === '\r\n'
            ? ('crlf' as const)
            : ending === '\r'
              ? ('cr' as const)
              : ('lf' as const),
        ),
      );
      return {
        target,
        path,
        content: { kind: 'text', text },
        writable,
        version: {
          sha256: sha256(bytes),
          bytes: size,
          encoding: 'utf-8',
          bom: text.startsWith('\ufeff'),
          eol: endings.size > 1 ? 'mixed' : (endings.values().next().value ?? 'none'),
        },
      };
    });
  }

  documentOperation(sessionId: string, operationId: string): DocumentOperation {
    const receipt = this.workbenchOperations.get(operationId);
    if (
      !receipt ||
      receipt.target.sessionId !== sessionId ||
      !['document.save', 'document.rename', 'document.delete'].includes(receipt.kind)
    )
      throw new WorkspaceError('TARGET_NOT_FOUND', 'the document operation is unavailable');
    const owner = this.workspaceAccess.get({ kind: 'user', id: operationId });
    return {
      ...receipt,
      ...(owner?.state === 'uncertain' ? { state: 'uncertain' as const } : {}),
    } as DocumentOperation;
  }

  async changeDocument(sessionId: string, raw: DocumentCommand): Promise<DocumentOperation> {
    const command = DocumentCommand.parse(raw);
    command.path = safeRelative(command.path);
    if (command.kind === 'rename') command.toPath = safeRelative(command.toPath);
    const request =
      command.kind === 'save'
        ? { ...command, text: sha256(Buffer.from(command.text, 'utf8')) }
        : command;
    const requestHash = sha256(Buffer.from(canonicalJson(request)));
    const kind = `document.${command.kind}` as DocumentOperation['kind'];
    const checkpointId = `checkpoint_${sha256(Buffer.from(command.operationId)).slice(0, 32)}`;
    const intent: DocumentMutationIntent = {
      path: command.path,
      baseHash: command.baseHash,
      ...(command.kind === 'save'
        ? {
            submittedHash: sha256(Buffer.from(command.text, 'utf8')),
            editVersion: command.editVersion,
          }
        : command.kind === 'rename'
          ? { toPath: command.toPath }
          : {
              checkpointId: `checkpoint_${sha256(Buffer.from(command.operationId)).slice(0, 32)}`,
            }),
    };
    const prior = this.workbenchOperations.get(command.operationId);
    if (prior) {
      if (prior.requestHash !== requestHash || prior.kind !== kind)
        throw new WorkspaceError('REVISION_CONFLICT', 'operation request changed');
      return this.documentOperation(sessionId, command.operationId);
    }
    const { row } = this.documentTarget(sessionId, command.target, true);
    return this.lease(row.worktree_path, async () => {
      if ((await realpath(row.worktree_path)) !== resolve(row.worktree_path))
        throw new WorkspaceError('REVISION_CONFLICT', 'the working copy identity changed');
      this.documentTarget(sessionId, command.target, true);
      const admitted = this.workbenchOperations.admit(
        {
          operationId: command.operationId,
          target: command.target,
          kind,
          requestHash,
        },
        row.worktree_path,
        { kind: 'pending', intent },
      );
      if (!admitted.admitted) return this.documentOperation(sessionId, command.operationId);
      const owner = { kind: 'user', id: command.operationId } as const;
      let attempted = false;
      let temporary: string | undefined;
      try {
        await expectFile(row.worktree_path, command.path, command.baseHash);
        if (
          command.baseHash !== null &&
          decodeText(await textBytes(row.worktree_path, command.path), true) === null
        )
          throw new ToolRefusal('CAPABILITY_DENIED', 'documents must be UTF-8 text');
        const tree = await this.snapshotTree(row.worktree_path);
        this.workspaceAccess.pin(owner, tree);
        const source = join(row.worktree_path, command.path);
        let result: DocumentOperation['result'];
        if (command.kind === 'save') {
          const bytes = Buffer.from(command.text, 'utf8');
          if (bytes.length > MAX_TEXT)
            throw new ToolRefusal('LIMIT_REACHED', 'documents are at most 1 MiB');
          if (decodeText(bytes, true) === null)
            throw new ToolRefusal('CAPABILITY_DENIED', 'documents must be UTF-8 text');
          const mode = command.baseHash === null ? 0o644 : (await stat(source)).mode & 0o777;
          await mkdir(dirname(source), { recursive: true });
          await assertPlainPath(row.worktree_path, command.path);
          temporary = join(dirname(source), `.${basename(source)}.corral-${randomUUID()}`);
          await this.io.writeFile(temporary, bytes, { mode, flag: 'wx', flush: true });
          if (command.baseHash !== null) await chmod(temporary, mode);
          await expectFile(row.worktree_path, command.path, command.baseHash);
          this.documentTarget(sessionId, command.target, true);
          attempted = true;
          if (command.baseHash === null) await this.io.link(temporary, source);
          else await this.io.rename(temporary, source);
          const saved = await textBytes(row.worktree_path, command.path);
          if (sha256(saved) !== sha256(bytes))
            throw new ToolRefusal('REVISION_CONFLICT', 'the document changed during save');
          result = {
            kind: 'saved',
            intent,
            path: command.path,
            sha256: sha256(saved),
            bytes: saved.length,
            editVersion: command.editVersion,
          };
        } else if (command.kind === 'rename') {
          await expectFile(row.worktree_path, command.toPath, null);
          const destination = join(row.worktree_path, command.toPath);
          await mkdir(dirname(destination), { recursive: true });
          await expectFile(row.worktree_path, command.path, command.baseHash);
          await expectFile(row.worktree_path, command.toPath, null);
          this.documentTarget(sessionId, command.target, true);
          attempted = true;
          // Hard-link creation refuses a destination that appeared after the preflight.
          await this.io.link(source, destination);
          await expectFile(row.worktree_path, command.path, command.baseHash);
          await expectFile(row.worktree_path, command.toPath, command.baseHash);
          this.documentTarget(sessionId, command.target, true);
          await this.io.unlink(source);
          await expectFile(row.worktree_path, command.path, null);
          await expectFile(row.worktree_path, command.toPath, command.baseHash);
          result = {
            kind: 'renamed',
            intent,
            path: command.path,
            toPath: command.toPath,
            sha256: command.baseHash,
          };
        } else {
          const checkpoint = await this.checkpointAt(row, {
            checkpointId,
            label: 'Before document deletion',
            kind: 'manual',
            tree,
            pinned: true,
          });
          if (!checkpoint.tree)
            throw new ToolRefusal('CAPABILITY_DENIED', 'the recovery checkpoint is incomplete');
          await this.requireLspSnapshot(
            row.worktree_path,
            checkpoint.tree,
            command.path,
            command.baseHash,
          ).catch(() => {
            throw new ToolRefusal(
              'CAPABILITY_DENIED',
              'the recovery checkpoint does not retain the original document bytes',
            );
          });
          await expectFile(row.worktree_path, command.path, command.baseHash);
          this.documentTarget(sessionId, command.target, true);
          attempted = true;
          await this.io.unlink(source);
          await expectFile(row.worktree_path, command.path, null);
          result = {
            kind: 'deleted',
            intent,
            path: command.path,
            checkpointId: checkpoint.checkpointId,
          };
        }
        this.workbenchOperations.finish(command.operationId, 'succeeded', result);
        return this.documentOperation(sessionId, command.operationId);
      } catch (error) {
        let unchanged = !attempted;
        if (attempted) {
          try {
            await expectFile(row.worktree_path, command.path, command.baseHash);
            if (command.kind === 'rename')
              await expectFile(row.worktree_path, command.toPath, null);
            unchanged = true;
          } catch {
            /* A partial or unconfirmed effect retains its writer reservation. */
          }
        }
        const state = unchanged ? 'failed' : 'uncertain';
        const result = {
          kind: 'error' as const,
          intent,
          code:
            error instanceof ToolRefusal || error instanceof WorkspaceError
              ? error.code
              : ('STORAGE_UNAVAILABLE' as const),
          message:
            error instanceof ToolRefusal || error instanceof WorkspaceError
              ? error.message
              : 'The document change could not be confirmed.',
        };
        try {
          this.workbenchOperations.finish(command.operationId, state, result);
        } catch {
          this.workspaceAccess.release(owner, false);
          throw new ToolRefusal(
            'STORAGE_UNAVAILABLE',
            'The document result could not be recorded; read the original operation again.',
          );
        }
        return this.documentOperation(sessionId, command.operationId);
      } finally {
        if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }

  /** A restore target is always a trusted session-owned copy or its linked original repository. */
  private async checkpointTarget(
    sessionId: string,
    target: 'working_copy' | 'original' = 'working_copy',
  ) {
    const row = this.worktree(sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    const binding = this.db
      .prepare('SELECT * FROM workspace_bindings WHERE id=? AND trusted=1')
      .get(row.binding_id) as BindingRow | undefined;
    if (!binding)
      throw new WorkspaceError('CAPABILITY_DENIED', 'trust the repository before changing files');
    if (target === 'working_copy') return row;
    const root = await realpath(binding.root_path);
    const common = async (path: string) =>
      realpath(resolve(path, await gitText(path, ['rev-parse', '--git-common-dir'])));
    if ((await common(root)) !== (await common(row.worktree_path)))
      throw new WorkspaceError('REVISION_CONFLICT', 'the linked Git repository changed');
    return { ...row, worktree_path: root };
  }

  /** Serializes legacy whole-file integration with hunk/restore writes and preserves its target first. */
  async withOriginalCheckpoint<T>(
    sessionId: string,
    label: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const row = await this.checkpointTarget(sessionId, 'original');
    return this.lease(row.worktree_path, async () => {
      await this.checkpointAt(row, {
        checkpointId: `checkpoint_${randomUUID().replaceAll('-', '')}`,
        label,
        kind: 'before_restore',
        target: 'original',
        pinned: true,
      });
      return work();
    });
  }

  private async requireSessionTree(sessionId: string, tree: string) {
    const row = this.worktree(sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    if (
      [row.base_tree, row.reviewed_tree].includes(tree) ||
      this.db
        .prepare('SELECT 1 FROM run_snapshots WHERE session_id=? AND tree=?')
        .get(sessionId, tree) ||
      this.checkpoints(sessionId).some((item) => item.state === 'ready' && item.tree === tree)
    )
      return;
    const latest = await gitText(row.worktree_path, [
      'rev-parse',
      '--verify',
      `refs/corral/${sessionId}/latest`,
    ]).catch(() => null);
    if (latest !== tree)
      throw new WorkspaceError(
        'REVISION_CONFLICT',
        'the diff tree is not retained by this session',
      );
  }

  private async hunkPatch(sessionId: string, raw: unknown) {
    const input = HunkRequest.parse(raw),
      path = safeRelative(input.path);
    if (/[\r\n]/.test(path))
      throw new WorkspaceError('CAPABILITY_DENIED', 'hunk paths cannot contain line breaks');
    const row = this.worktree(sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    await this.requireSessionTree(sessionId, input.from);
    await this.requireSessionTree(sessionId, input.to);
    const modes: string[] = [];
    for (const tree of [input.from, input.to]) {
      const value = await gitText(row.worktree_path, ['ls-tree', tree, '--', `:(literal)${path}`]);
      if (value && !/^(100644|100755) blob /.test(value))
        throw new WorkspaceError('CAPABILITY_DENIED', 'hunks support plain text files only');
      modes.push(value.split(' ')[0] ?? '');
    }
    if (modes[0] && modes[1] && modes[0] !== modes[1])
      throw new WorkspaceError('CAPABILITY_DENIED', 'file mode changes require whole-file review');
    const sides = await this.fileVersions(sessionId, input.from, input.to, path);
    if ([sides.before, sides.after].some((side) => !['text', 'absent'].includes(side.kind)))
      throw new WorkspaceError('CAPABILITY_DENIED', 'hunks require UTF-8 text up to 1 MiB');
    const patch = (
      await git(
        row.worktree_path,
        [
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--full-index',
          '--no-renames',
          '--unified=3',
          input.from,
          input.to,
          '--',
          `:(literal)${path}`,
        ],
        { maxBuffer: 3 * MAX_TEXT },
      )
    ).stdout.toString('utf8');
    const chunks = patch.split(/(?=^@@ )/m),
      header = chunks.shift() ?? '';
    if (!chunks.length || chunks.length > 200)
      throw new WorkspaceError(
        'CAPABILITY_DENIED',
        'this diff has no selectable text hunks or exceeds 200 hunks',
      );
    const patchHash = sha256(Buffer.from(patch));
    const hunks = chunks.map((patch, index) => ({
      id: sha256(Buffer.from(`${patchHash}:${index}:${patch}`)),
      patch,
    }));
    return { ...input, path, patchHash, hunks, header, row, sides };
  }

  async hunks(sessionId: string, raw: unknown): Promise<HunkSet> {
    const {
      header: _header,
      row: _row,
      sides: _sides,
      ...view
    } = await this.hunkPatch(sessionId, raw);
    return view;
  }

  async planHunks(sessionId: string, raw: unknown): Promise<CheckpointRestorePlan> {
    const input = HunkPlanRequest.parse(raw);
    const requestHash = sha256(Buffer.from(canonicalJson({ sessionId, ...input })));
    const existing = this.checkpoints(sessionId).find((item) => item.checkpointId === input.planId);
    if (existing) {
      if (existing.state !== 'ready' || existing.hunk?.requestHash !== requestHash)
        throw new WorkspaceError('REVISION_CONFLICT', 'hunk plan identity has different content');
      return {
        checkpointId: existing.checkpointId,
        manifestHash: existing.manifestHash!,
        target: existing.target,
        expectedTree: existing.hunk.expectedTree,
        targetTree: existing.tree!,
        files: [{ path: input.path, status: input.action }],
      };
    }
    const patch = await this.hunkPatch(sessionId, {
      from: input.from,
      to: input.to,
      path: input.path,
    });
    if (
      patch.patchHash !== input.patchHash ||
      input.hunkIds.some((id) => !patch.hunks.some((hunk) => hunk.id === id))
    )
      throw new WorkspaceError('REVISION_CONFLICT', 'selected patch changed');
    const target = input.action === 'apply_original' ? 'original' : 'working_copy';
    const row = await this.checkpointTarget(sessionId, target);
    return this.lease(row.worktree_path, async () => {
      const expectedSide =
        input.action === 'apply_original' ? patch.sides.before : patch.sides.after;
      const beforeHash =
        expectedSide.kind === 'text' ? sha256(Buffer.from(expectedSide.text)) : null;
      await expectFile(row.worktree_path, patch.path, beforeHash);
      const expectedTree = await this.snapshotTree(row.worktree_path);
      const index = join(tmpdir(), `corral-hunks-${randomUUID()}`),
        env = { GIT_INDEX_FILE: index };
      try {
        await git(row.worktree_path, ['read-tree', expectedTree], { env });
        const selected = Buffer.from(
          patch.header +
            patch.hunks
              .filter((hunk) => input.hunkIds.includes(hunk.id))
              .map((hunk) => hunk.patch)
              .join(''),
        );
        const args = [
          'apply',
          '--cached',
          '--whitespace=nowarn',
          ...(input.action === 'revert_working_copy' ? ['--reverse'] : []),
        ];
        await git(row.worktree_path, [...args, '--check'], { env, input: selected });
        await git(row.worktree_path, args, { env, input: selected });
        const tree = await gitText(row.worktree_path, ['write-tree'], env);
        const after = await this.blob(row.worktree_path, tree, patch.path);
        const hunk = {
          ...input,
          requestHash,
          expectedTree,
          beforeHash,
          afterHash: after ? sha256(after) : null,
        };
        const { planId: _planId, ...evidence } = hunk;
        const checkpoint = await this.checkpointAt(row, {
          checkpointId: input.planId,
          label: 'Selected hunk proposal',
          kind: 'hunk_proposal',
          target,
          hunk: evidence,
          tree,
          pinned: true,
        });
        return {
          checkpointId: checkpoint.checkpointId,
          manifestHash: checkpoint.manifestHash!,
          target,
          expectedTree,
          targetTree: tree,
          files: [{ path: patch.path, status: input.action }],
        };
      } finally {
        await rm(index, { force: true });
      }
    });
  }

  // ── snapshots ───────────────────────────────────────────────────────────────

  checkpoints(sessionId: string): FileCheckpoint[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM file_checkpoints WHERE session_id=? ORDER BY created_at DESC, rowid DESC',
      )
      .all(sessionId) as {
      manifest_json: string;
      manifest_hash: string | null;
      state: FileCheckpoint['state'];
      pinned: number;
    }[];
    return rows.map((row) => ({
      ...JSON.parse(row.manifest_json),
      manifestHash: row.manifest_hash,
      state: row.state,
      pinned: row.pinned === 1,
    }));
  }

  private async checkpointAt(
    row: WorktreeRow,
    input: {
      checkpointId: string;
      label: string;
      kind: CheckpointManifest['kind'];
      target?: CheckpointManifest['target'];
      hunk?: CheckpointManifest['hunk'];
      runId?: string;
      tree?: string;
      pinned: boolean;
    },
  ): Promise<FileCheckpoint> {
    const existing = this.db
      .prepare('SELECT session_id FROM file_checkpoints WHERE id=?')
      .get(input.checkpointId) as { session_id: string } | undefined;
    if (existing) {
      const found = this.checkpoints(existing.session_id).find(
        (item) => item.checkpointId === input.checkpointId,
      )!;
      if (
        existing.session_id !== row.session_id ||
        found.label !== input.label ||
        found.kind !== input.kind ||
        (found.target ?? 'working_copy') !== (input.target ?? 'working_copy') ||
        found.hunk?.requestHash !== input.hunk?.requestHash ||
        (input.tree !== undefined && found.tree !== input.tree)
      )
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          'checkpoint identity already belongs to another request',
        );
      if (found.state !== 'ready')
        throw new WorkspaceError('REVISION_CONFLICT', 'checkpoint is not complete');
      return found;
    }
    const run = input.runId
      ? (this.db.prepare('SELECT session_id,last_seq FROM runs WHERE id=?').get(input.runId) as
          | { session_id: string; last_seq: number }
          | undefined)
      : undefined;
    if (input.runId && run?.session_id !== row.session_id)
      throw new WorkspaceError(
        'TARGET_NOT_FOUND',
        'checkpoint Run does not belong to this session',
      );
    const draft = {
      version: 2 as const,
      target: input.target ?? 'working_copy',
      ...(input.hunk ? { hunk: input.hunk } : {}),
      checkpointId: input.checkpointId,
      sessionId: row.session_id,
      runId: input.runId ?? null,
      runSeq: input.kind === 'before_run' ? 0 : (run?.last_seq ?? null),
      kind: input.kind,
      label: input.label,
      tree: null,
      createdAt: this.clock.nowIso(),
      files: 'tracked_and_unignored' as const,
    };
    this.db
      .prepare(`INSERT INTO file_checkpoints (id,session_id,run_id,kind,manifest_json,manifest_hash,state,pinned,created_at)
      VALUES (?,?,?,?,?,NULL,'incomplete',?,?)`)
      .run(
        input.checkpointId,
        row.session_id,
        draft.runId,
        input.kind,
        canonicalJson(draft),
        Number(input.pinned),
        draft.createdAt,
      );
    const manifest = CheckpointManifest.parse({
      ...draft,
      tree: input.tree ?? (await this.snapshotTree(row.worktree_path)),
    });
    const body = canonicalJson(manifest),
      hash = sha256(Buffer.from(body));
    this.db
      .prepare('UPDATE file_checkpoints SET manifest_json=?,manifest_hash=? WHERE id=?')
      .run(body, hash, input.checkpointId);
    await this.pin(
      row.worktree_path,
      this.checkpointRef(row.session_id, input.checkpointId),
      manifest.tree,
    );
    this.db.prepare("UPDATE file_checkpoints SET state='ready' WHERE id=?").run(input.checkpointId);
    return { ...manifest, manifestHash: hash, state: 'ready', pinned: input.pinned };
  }

  async captureCheckpoint(sessionId: string, raw: unknown): Promise<FileCheckpoint> {
    const input = CaptureCheckpoint.parse(raw);
    const row = await this.checkpointTarget(sessionId, input.target);
    return this.lease(row.worktree_path, () =>
      this.checkpointAt(row, { ...input, kind: 'manual', pinned: true }),
    );
  }

  private checkpointRef(sessionId: string, checkpointId: string) {
    return `refs/corral/${sessionId}/checkpoints/${sha256(Buffer.from(checkpointId))}`;
  }

  pinCheckpoint(sessionId: string, checkpointId: string, pinned: boolean) {
    const result = this.db
      .prepare("UPDATE file_checkpoints SET pinned=? WHERE id=? AND session_id=? AND state='ready'")
      .run(Number(pinned), checkpointId, sessionId);
    if (!result.changes) throw new WorkspaceError('TARGET_NOT_FOUND', 'no complete checkpoint');
  }

  async pruneCheckpoints(sessionId: string) {
    const row = this.worktree(sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    return this.lease(row.worktree_path, async () => {
      const referenced = new Set(
        this.checkpointRestores(sessionId).flatMap((item) => [
          item.checkpointId,
          item.beforeCheckpointId,
        ]),
      );
      const cutoff = Date.parse(this.clock.nowIso()) - 30 * 86400_000;
      const expired: string[] = [];
      for (const checkpoint of this.checkpoints(sessionId)
        .filter((item) => item.state === 'ready')
        .slice(50)) {
        if (
          checkpoint.pinned ||
          checkpoint.kind === 'runtime' ||
          referenced.has(checkpoint.checkpointId) ||
          Date.parse(checkpoint.createdAt) >= cutoff
        )
          continue;
        this.db
          .prepare("UPDATE file_checkpoints SET state='expired' WHERE id=?")
          .run(checkpoint.checkpointId);
        await git(row.worktree_path, [
          'update-ref',
          '-d',
          this.checkpointRef(sessionId, checkpoint.checkpointId),
        ]);
        expired.push(checkpoint.checkpointId);
      }
      return { expired };
    });
  }

  checkpointRestores(sessionId: string): CheckpointRestore[] {
    return (
      this.db
        .prepare(
          'SELECT result_json FROM checkpoint_restores WHERE session_id=? ORDER BY rowid DESC',
        )
        .all(sessionId) as { result_json: string }[]
    ).map((row) => JSON.parse(row.result_json));
  }

  async planCheckpointRestore(
    sessionId: string,
    checkpointId: string,
    manifestHash: string,
  ): Promise<CheckpointRestorePlan> {
    const selected = this.checkpoints(sessionId).find((item) => item.checkpointId === checkpointId);
    const row = await this.checkpointTarget(sessionId, selected?.target);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    return this.lease(row.worktree_path, async () => {
      const checkpoint = this.checkpoints(sessionId).find(
        (item) => item.checkpointId === checkpointId,
      );
      if (
        !checkpoint ||
        checkpoint.state !== 'ready' ||
        !checkpoint.tree ||
        checkpoint.manifestHash !== manifestHash
      )
        throw new WorkspaceError('REVISION_CONFLICT', 'checkpoint is not complete or has changed');
      const expectedTree = await this.snapshotTree(row.worktree_path);
      if (checkpoint.hunk && checkpoint.hunk.expectedTree !== expectedTree)
        throw new WorkspaceError('REVISION_CONFLICT', 'hunk target changed since preview');
      return {
        checkpointId,
        manifestHash,
        target: checkpoint.target ?? 'working_copy',
        expectedTree,
        targetTree: checkpoint.tree,
        files: await this.changedPaths(row.worktree_path, expectedTree, checkpoint.tree),
      };
    });
  }

  async restoreCheckpoint(sessionId: string, raw: unknown): Promise<CheckpointRestore> {
    const request = RestoreCheckpoint.parse(raw);
    const requestHash = sha256(Buffer.from(canonicalJson({ sessionId, ...request })));
    const selected = this.checkpoints(sessionId).find(
      (item) => item.checkpointId === request.checkpointId,
    );
    const row = await this.checkpointTarget(sessionId, selected?.target);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'this session has no working copy');
    return this.lease(row.worktree_path, async () => {
      const previous = this.db
        .prepare('SELECT request_hash,result_json FROM checkpoint_restores WHERE id=?')
        .get(request.operationId) as { request_hash: string; result_json: string } | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new WorkspaceError('REVISION_CONFLICT', 'restore identity has different content');
        return JSON.parse(previous.result_json) as CheckpointRestore;
      }
      const record = this.db
        .prepare('SELECT * FROM file_checkpoints WHERE id=? AND session_id=?')
        .get(request.checkpointId, sessionId) as
        | { state: string; manifest_json: string; manifest_hash: string }
        | undefined;
      if (!record || record.state !== 'ready')
        throw new WorkspaceError('TARGET_NOT_FOUND', 'checkpoint is not complete');
      if (
        record.manifest_hash !== request.manifestHash ||
        sha256(Buffer.from(record.manifest_json)) !== request.manifestHash
      )
        throw new WorkspaceError('REVISION_CONFLICT', 'checkpoint manifest changed');
      const manifest = CheckpointManifest.parse(JSON.parse(record.manifest_json));
      const refTree = await gitText(row.worktree_path, [
        'rev-parse',
        '--verify',
        this.checkpointRef(sessionId, request.checkpointId),
      ]);
      if (
        manifest.sessionId !== sessionId ||
        manifest.checkpointId !== request.checkpointId ||
        refTree !== manifest.tree
      )
        throw new WorkspaceError('REVISION_CONFLICT', 'checkpoint retention reference changed');
      if ((await this.snapshotTree(row.worktree_path)) !== request.expectedTree)
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          'working copy changed since the restore was prepared',
        );
      if (manifest.hunk) {
        if (manifest.hunk.expectedTree !== request.expectedTree)
          throw new WorkspaceError(
            'REVISION_CONFLICT',
            'hunk approval belongs to another target tree',
          );
        await expectFile(row.worktree_path, manifest.hunk.path, manifest.hunk.beforeHash);
      }
      const paths = await this.changedPaths(row.worktree_path, request.expectedTree, manifest.tree);
      if (paths.length > 10000)
        throw new WorkspaceError('CAPABILITY_DENIED', 'restore is limited to 10000 files');
      for (const file of paths) {
        safeRelative(file.path);
        await assertPlainPath(row.worktree_path, file.path);
        for (const tree of [request.expectedTree, manifest.tree]) {
          const entry = await gitText(row.worktree_path, [
            'ls-tree',
            tree,
            '--',
            `:(literal)${file.path}`,
          ]);
          if (entry && !/^(100644|100755) blob /.test(entry))
            throw new WorkspaceError('CAPABILITY_DENIED', 'restore supports plain files only');
        }
        if (paths.some((other) => other.path.startsWith(`${file.path}/`)))
          throw new WorkspaceError(
            'CAPABILITY_DENIED',
            'file/directory transitions require manual recovery',
          );
      }
      const beforeId = `checkpoint_${requestHash.slice(0, 32)}`;
      const result: CheckpointRestore = {
        operationId: request.operationId,
        target: manifest.target ?? 'working_copy',
        checkpointId: request.checkpointId,
        beforeCheckpointId: beforeId,
        from: request.expectedTree,
        to: manifest.tree,
        state: 'applying',
        createdAt: this.clock.nowIso(),
      };
      const save = () =>
        this.db
          .prepare('UPDATE checkpoint_restores SET result_json=? WHERE id=?')
          .run(canonicalJson(result), request.operationId);
      this.db
        .prepare(
          'INSERT INTO checkpoint_restores (id,session_id,request_hash,result_json) VALUES (?,?,?,?)',
        )
        .run(request.operationId, sessionId, requestHash, canonicalJson(result));
      const index = join(tmpdir(), `corral-restore-${randomUUID()}`);
      const env = { GIT_INDEX_FILE: index };
      try {
        await this.checkpointAt(row, {
          checkpointId: beforeId,
          label: 'Before checkpoint restore',
          kind: 'before_restore',
          target: manifest.target ?? 'working_copy',
          tree: request.expectedTree,
          pinned: true,
        });
        if ((await this.snapshotTree(row.worktree_path)) !== request.expectedTree)
          throw new Error('changed before restore');
        const currentTarget = await this.checkpointTarget(sessionId, manifest.target);
        if (currentTarget.worktree_path !== row.worktree_path)
          throw new Error('restore target changed');
        await git(row.worktree_path, ['read-tree', request.expectedTree], { env });
        await git(row.worktree_path, ['update-index', '--refresh'], { env });
        // Git refuses dirty paths and untracked collisions; never --reset or --force.
        await git(
          row.worktree_path,
          ['read-tree', '-u', '-m', request.expectedTree, manifest.tree],
          { env },
        );
        if (manifest.hunk)
          await expectFile(row.worktree_path, manifest.hunk.path, manifest.hunk.afterHash);
        result.state =
          (await this.snapshotTree(row.worktree_path)) === manifest.tree ? 'applied' : 'partial';
      } catch {
        const current = await this.snapshotTree(row.worktree_path).catch(() => null);
        result.state =
          current === request.expectedTree ? 'refused' : current ? 'partial' : 'uncertain';
      } finally {
        await rm(index, { force: true });
      }
      save();
      return result;
    });
  }

  private async pin(worktree: string, ref: string, tree: string) {
    await git(worktree, ['update-ref', ref, tree]);
  }

  /** The worktree as a git tree, from a temporary index; .gitignore'd files are left out. */
  private async snapshotTree(worktree: string, isolation?: 'linux-bwrap'): Promise<string> {
    const index = join(tmpdir(), `corral-index-${randomUUID()}`);
    const env = {
      ...(isolation ? await checkGitEnvironment(worktree) : {}),
      GIT_INDEX_FILE: index,
    };
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
    if (phase === 'end') {
      this.reads.delete(runId);
      this.hashlineReads.delete(runId);
    }
    const row = this.worktree(sessionId);
    if (!row) return null;
    const existing = this.runTree(runId, phase);
    if (existing) return existing;
    const key = `${runId}:${phase}`;
    const pending = this.pendingSnapshots.get(key);
    if (pending) return pending;
    const work = this.lease(row.worktree_path, async () => {
      const access = this.runAccess.get(runId);
      const tree =
        access?.writer === 0 && access.tree
          ? access.tree
          : await this.snapshotTree(row.worktree_path);
      await this.pin(row.worktree_path, `refs/corral/${sessionId}/runs/${runId}/${phase}`, tree);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO run_snapshots (run_id, phase, session_id, tree, captured_at)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, phase, sessionId, tree, this.clock.nowIso());
      await this.checkpointAt(row, {
        checkpointId: `checkpoint_${sha256(Buffer.from(`${runId}:${phase}`)).slice(0, 32)}`,
        label: phase === 'start' ? 'Before Run' : 'After Run',
        kind: phase === 'start' ? 'before_run' : 'after_run',
        runId,
        tree,
        pinned: false,
      });
      return tree;
    });
    this.pendingSnapshots.set(key, work);
    try {
      return await work;
    } finally {
      this.pendingSnapshots.delete(key);
    }
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
    await this.lease(row.worktree_path, () =>
      this.checkpointAt(row, {
        checkpointId: `checkpoint_${sha256(Buffer.from(`${runId}:start`)).slice(0, 32)}`,
        label: 'Before Run',
        kind: 'before_run',
        runId,
        tree,
        pinned: false,
      }),
    );
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
    if (runEnded(scope.runId)) await this.pendingSnapshots.get(`${scope.runId}:end`);
    const end = runEnded(scope.runId) ? this.runTree(scope.runId, 'end') : await now();
    if (!end)
      return { from: start, to: null, unavailable: 'no end tree was recorded for this run', row };
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
    const { bytes, size } = await boundedFile(root, rel);
    if (!bytes) return { path: rel, content: { kind: 'too_large', bytes: size } };
    const text = decodeText(bytes);
    return {
      path: rel,
      content: text === null ? { kind: 'binary', bytes: size } : { kind: 'text', text },
    };
  }

  verifications(sessionId: string, currentTree: string | null): VerificationView[] {
    this.db
      .prepare(
        `UPDATE verifications SET output_tail = '', report_json = json_set(report_json, '$.output.text', '') WHERE report_json IS NOT NULL AND json_extract(report_json, '$.retainUntil') < ?`,
      )
      .run(this.clock.nowIso());
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
      report_json: string | null;
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
        stale: currentTree === null || currentTree !== r.tree,
        report: r.report_json ? VerificationReport.parse(JSON.parse(r.report_json)) : null,
      };
    });
  }

  /** The worktree's tree now, without pinning it. */
  async currentTree(sessionId: string, isolation?: 'linux-bwrap'): Promise<string | null> {
    const row = this.worktree(sessionId);
    if (!row) return null;
    return this.lease(row.worktree_path, () => this.snapshotTree(row.worktree_path, isolation));
  }

  /** A manual click authorizes this one launch; automatic callers require fingerprint trust. */
  async verify(sessionId: string, projectId: string, commandId: string): Promise<string> {
    const binding = this.binding(projectId);
    const row = this.worktree(sessionId);
    if (!binding || !row || row.binding_id !== binding.id)
      throw new WorkspaceError('TARGET_NOT_FOUND', 'no working copy to check');
    if (!binding.trusted)
      throw new WorkspaceError('CAPABILITY_DENIED', 'trust the repository before running checks');
    const config = this.projectTools.latest(projectId);
    const command = config?.checks.find((c) => c.id === commandId);
    if (!config || !command) throw new WorkspaceError('TARGET_NOT_FOUND', 'no such check');
    const { tree, launch } = await this.lease(row.worktree_path, async () => {
      if (this.hasUnsafeWorktreeOwner(sessionId))
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          'finish the working copy writer before checking',
        );
      const tree = await this.snapshotTree(row.worktree_path);
      const launch = await launchFingerprint(row.worktree_path, config.revision, command);
      if (this.hasUnsafeWorktreeOwner(sessionId))
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          'working copy writer ownership changed while preparing the check',
        );
      return { tree, launch };
    });
    return this.startCheck(
      sessionId,
      projectId,
      row.worktree_path,
      command,
      config.revision,
      tree,
      launch.fingerprint,
      { kind: 'manual', sessionId },
    );
  }

  private projectToolContext(input: Pick<CheckExecution, 'runId' | 'selection'>) {
    const access = this.runAccess.get(input.runId);
    if (access && (access.state !== 'active' || !access.writer))
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'process tools require an active working copy writer',
      );
    const sessionId = this.sessionOfRun(input.runId);
    const row = sessionId ? this.worktree(sessionId) : null;
    const binding = this.binding(input.selection.projectId);
    if (!sessionId || !row || !binding || row.binding_id !== binding.id || !binding.trusted)
      throw new ToolRefusal('CAPABILITY_DENIED', 'trusted working copy unavailable');
    const config = this.projectTools.get(input.selection.projectId, input.selection.revision);
    if (!config || config.hash !== input.selection.hash)
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'check is not selected in the pinned configuration',
      );
    return { sessionId, row, config };
  }

  private checkContext(input: CheckExecution) {
    const context = this.projectToolContext(input);
    if (!input.selection.checkIds.includes(input.commandId))
      throw new ToolRefusal('CAPABILITY_DENIED', 'check is not selected');
    const command = context.config.checks.find((check) => check.id === input.commandId);
    if (!command) throw new ToolRefusal('TARGET_NOT_FOUND', 'check is not registered');
    return { ...context, command };
  }

  private lspContext(input: LspExecution) {
    const context = this.projectToolContext(input),
      query = LspQuery.parse(input.query);
    if (!input.selection.lspServerIds.includes(query.serverId))
      throw new ToolRefusal('CAPABILITY_DENIED', 'language server is not selected');
    const server = context.config.lspServers.find((server) => server.id === query.serverId);
    if (!server) throw new ToolRefusal('TARGET_NOT_FOUND', 'language server is not registered');
    if (
      !server.fileExtensions.some((extension) =>
        query.path.toLowerCase().endsWith(extension.toLowerCase()),
      )
    )
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'language server does not support this file extension',
      );
    const languageId =
      query.languageId ?? (server.languageIds.length === 1 ? server.languageIds[0] : undefined);
    if (!languageId || !server.languageIds.includes(languageId))
      throw new ToolRefusal(
        'SCHEMA_INVALID',
        `choose a registered language ID: ${server.languageIds.join(', ')}`,
      );
    return { ...context, query, server, languageId };
  }

  async planLsp(input: LspExecution, cancellation: ToolCancellation): Promise<CheckPlan> {
    const { row, config, query, server } = this.lspContext(input);
    if (cancellation.aborted)
      throw new ToolRefusal('TARGET_TERMINAL', 'language server query cancelled');
    const plan = await this.lease(row.worktree_path, async () => {
      const bytes = await textBytes(row.worktree_path, safeRelative(query.path));
      const text = decodeText(bytes, true);
      if (text === null) throw new ToolRefusal('CAPABILITY_DENIED', 'LSP requires UTF-8 text');
      if ('position' in query) validateLspPosition(query.position, text);
      if ('range' in query) {
        validateLspPosition(query.range.start, text);
        validateLspPosition(query.range.end, text);
      }
      const tree = await this.snapshotTree(row.worktree_path),
        launch = await launchFingerprint(row.worktree_path, config.revision, server);
      return CheckPlan.parse({
        purpose: 'lsp',
        query,
        commandId: server.id,
        name: server.name,
        argv: server.argv,
        timeoutMs: server.timeoutMs,
        configRevision: config.revision,
        tree,
        fingerprint: launch.fingerprint,
        trusted:
          this.projectTools.trust({
            projectId: config.projectId,
            kind: 'lsp',
            id: server.id,
            fingerprint: launch.fingerprint,
          }) !== null,
      });
    });
    if (cancellation.aborted)
      throw new ToolRefusal('TARGET_TERMINAL', 'language server query cancelled');
    return plan;
  }

  async runLsp(
    input: LspExecution,
    rawPlan: CheckPlan,
    approvedFingerprint: string | null,
    cancellation: ToolCancellation,
  ): Promise<LspReport> {
    const plan = CheckPlan.parse(rawPlan),
      { sessionId, row, config, query, server, languageId } = this.lspContext(input);
    const now = await this.planLsp(input, cancellation);
    if (
      plan.purpose !== 'lsp' ||
      canonicalJson(plan.query) !== canonicalJson(query) ||
      plan.tree !== now.tree ||
      plan.fingerprint !== now.fingerprint ||
      plan.configRevision !== now.configRevision
    )
      throw new ToolRefusal('REVISION_CONFLICT', 'language server target or launch changed');
    if (!now.trusted && approvedFingerprint !== now.fingerprint)
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'language server requires trust or exact fingerprint approval',
      );
    const bytes = await textBytes(row.worktree_path, safeRelative(query.path));
    const text = decodeText(bytes, true);
    if (text === null) throw new ToolRefusal('CAPABILITY_DENIED', 'LSP requires UTF-8 text');
    const proposesChanges = query.operation === 'rename' || query.operation === 'code_actions';
    if (proposesChanges)
      await this.requireLspSnapshot(row.worktree_path, plan.tree, query.path, sha256(bytes));
    const launch = await launchFingerprint(row.worktree_path, config.revision, server);
    if (launch.fingerprint !== plan.fingerprint || !this.binding(config.projectId)?.trusted)
      throw new ToolRefusal('REVISION_CONFLICT', 'language server launch changed');
    if (
      approvedFingerprint !== plan.fingerprint &&
      !this.projectTools.trust({
        projectId: config.projectId,
        kind: 'lsp',
        id: server.id,
        fingerprint: plan.fingerprint,
      })
    )
      throw new ToolRefusal('CAPABILITY_DENIED', 'language server launch trust was revoked');
    if (cancellation.aborted)
      throw new ToolRefusal('TARGET_TERMINAL', 'language server query cancelled');
    const raw = await this.lsp.query(
      {
        cwd: row.worktree_path,
        argv: [launch.executable, ...server.argv.slice(1)],
        timeoutMs: server.timeoutMs,
        document: {
          uri: pathToFileURL(join(row.worktree_path, query.path)).href,
          text,
          languageId,
          version: 1,
        },
        operation: query.operation,
        ...('position' in query ? { position: query.position } : {}),
        ...(query.operation === 'rename' ? { newName: query.newName } : {}),
        ...(query.operation === 'code_actions'
          ? { range: query.range, ...(query.only ? { only: query.only } : {}) }
          : {}),
      },
      cancellation,
    );
    const source = { path: query.path, sha256: sha256(bytes), text };
    const readUri = async (uri: string) => {
      let path: string;
      try {
        path = safeRelative(relative(row.worktree_path, fileURLToPath(uri)).split(sep).join('/'));
      } catch {
        throw new ToolRefusal(
          'CAPABILITY_DENIED',
          'language server returned a location outside the working copy scope',
        );
      }
      const bytes = await textBytes(row.worktree_path, path),
        text = decodeText(bytes, true);
      if (text === null) throw new ToolRefusal('CAPABILITY_DENIED', 'LSP result is not UTF-8 text');
      if (proposesChanges)
        await this.requireLspSnapshot(row.worktree_path, plan.tree, path, sha256(bytes));
      return { path, text, sha256: sha256(bytes) };
    };
    let result: LspReport['result'];
    if (raw.kind === 'edits') {
      if (raw.truncated)
        throw new ToolRefusal('LIMIT_REACHED', 'incomplete LSP changes cannot be proposed');
      result = await this.lease(row.worktree_path, async () => {
        await expectFile(row.worktree_path, safeRelative(query.path), source.sha256);
        const proposals: LspProposalContent[] = [];
        let proposalBytes = 0;
        const unavailable: Extract<LspReport['result'], { kind: 'proposals' }>['unavailable'] = [];
        for (const action of raw.actions) {
          const title = redactToolText(action.title, [row.worktree_path]).slice(0, 400);
          if (action.unsupported) {
            unavailable.push({ title, reason: action.unsupported });
            continue;
          }
          const files = await stageLspEdit(
            action.edit,
            { uri: pathToFileURL(join(row.worktree_path, query.path)).href, version: 1 },
            readUri,
          );
          if (!files.length) continue;
          proposalBytes += files.reduce(
            (sum, file) => sum + Buffer.byteLength(file.before) + Buffer.byteLength(file.after),
            0,
          );
          if (proposalBytes > 8 * 1024 * 1024)
            throw new ToolRefusal('LIMIT_REACHED', 'LSP proposal batch exceeds text limits');
          proposals.push(
            LspProposalContent.parse({
              proposalId: this.newLspProposalId(),
              sessionId,
              runId: input.runId,
              executionId: input.executionId,
              attemptNo: input.attemptNo,
              effectId: input.effectId,
              serverId: server.id,
              configRevision: config.revision,
              fingerprint: plan.fingerprint,
              tree: plan.tree,
              worktreeHash: this.worktreeHash(row),
              source: { path: query.path, sha256: source.sha256, version: 1 },
              title,
              files,
              createdAt: this.clock.nowIso(),
            }),
          );
        }
        if (cancellation.aborted)
          throw new ToolRefusal('TARGET_TERMINAL', 'language server query cancelled');
        if ((await this.snapshotTree(row.worktree_path)) !== plan.tree)
          throw new ToolRefusal(
            'REVISION_CONFLICT',
            'language server result is stale because the working copy changed',
          );
        if (cancellation.aborted)
          throw new ToolRefusal('TARGET_TERMINAL', 'language server query cancelled');
        this.db.transaction(() => {
          for (const proposal of proposals) this.saveLspProposal(proposal);
        })();
        return {
          kind: 'proposals' as const,
          proposals: proposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            title: proposal.title,
            hash: sha256(Buffer.from(canonicalJson(proposal))),
            files: proposal.files.map(({ path, beforeHash, afterHash }) => ({
              path,
              beforeHash,
              afterHash,
            })),
          })),
          unavailable,
        };
      });
    } else result = await lspResults(raw, source, readUri, row.worktree_path);
    if (cancellation.aborted)
      throw new ToolRefusal('TARGET_TERMINAL', 'language server query cancelled');
    if ((await this.currentTree(sessionId)) !== plan.tree)
      throw new ToolRefusal(
        'REVISION_CONFLICT',
        'language server result is stale because the working copy changed',
      );
    return LspReport.parse({
      serverId: server.id,
      operation: query.operation,
      configRevision: config.revision,
      fingerprint: plan.fingerprint,
      tree: plan.tree,
      source: { path: query.path, sha256: source.sha256, version: 1 },
      result,
      durationMs: raw.durationMs,
      truncated: raw.truncated,
    });
  }

  private worktreeHash(row: WorktreeRow) {
    return sha256(
      Buffer.from(
        canonicalJson({
          bindingId: row.binding_id,
          path: row.worktree_path,
          createdAt: row.created_at,
          baseCommit: row.base_commit,
        }),
      ),
    );
  }

  private async requireLspSnapshot(worktree: string, tree: string, path: string, hash: string) {
    try {
      const blob = await git(worktree, ['cat-file', 'blob', `${tree}:${safeRelative(path)}`], {
        maxBuffer: MAX_TEXT + 1,
      });
      if (sha256(blob.stdout) === hash) return;
    } catch {
      // Ignored files and Git filters cannot establish the original byte precondition.
    }
    throw new ToolRefusal(
      'REVISION_CONFLICT',
      'LSP changes require identical file bytes in the fixed Git snapshot',
    );
  }

  private saveLspProposal(content: LspProposalContent) {
    const hash = sha256(Buffer.from(canonicalJson(content)));
    const summary = {
      ...content,
      hash,
      files: content.files.map(({ path, beforeHash, afterHash }) => ({
        path,
        beforeHash,
        afterHash,
      })),
    };
    const outcomes = content.files.map((file) => ({ path: file.path, state: 'pending' }));
    this.db
      .prepare(`INSERT INTO lsp_proposals (id,session_id,content_json,summary_json,content_hash,state,outcomes_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',?,?,?)`)
      .run(
        content.proposalId,
        content.sessionId,
        JSON.stringify(content),
        JSON.stringify(summary),
        hash,
        JSON.stringify(outcomes),
        content.createdAt,
        content.createdAt,
      );
  }

  lspProposals(sessionId: string): LspProposalSummary[] {
    const rows = this.db
      .prepare(
        'SELECT summary_json,state,outcomes_json FROM lsp_proposals WHERE session_id=? ORDER BY created_at DESC LIMIT 100',
      )
      .all(sessionId) as { summary_json: string; state: string; outcomes_json: string }[];
    return rows.map((row) =>
      LspProposalSummary.parse({
        ...JSON.parse(row.summary_json),
        state: row.state,
        outcomes: JSON.parse(row.outcomes_json),
      }),
    );
  }

  lspProposal(sessionId: string, id: string): LspProposal {
    const row = this.db
      .prepare(
        'SELECT content_json,content_hash,state,outcomes_json FROM lsp_proposals WHERE session_id=? AND id=?',
      )
      .get(sessionId, id) as
      | { content_json: string; content_hash: string; state: string; outcomes_json: string }
      | undefined;
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'no such LSP proposal');
    const content = LspProposalContent.parse(JSON.parse(row.content_json));
    if (
      content.sessionId !== sessionId ||
      content.proposalId !== id ||
      sha256(Buffer.from(canonicalJson(content))) !== row.content_hash
    )
      throw new WorkspaceError('REVISION_CONFLICT', 'LSP proposal content hash changed');
    return LspProposal.parse({
      ...content,
      hash: row.content_hash,
      state: row.state,
      outcomes: JSON.parse(row.outcomes_json),
    });
  }

  private settleLspProposal(
    proposal: LspProposal,
    state: LspProposal['state'],
    outcomes = proposal.outcomes,
  ) {
    this.db
      .prepare('UPDATE lsp_proposals SET state=?,outcomes_json=?,updated_at=? WHERE id=?')
      .run(state, JSON.stringify(outcomes), this.clock.nowIso(), proposal.proposalId);
    return this.lspProposal(proposal.sessionId, proposal.proposalId);
  }

  dismissLspProposal(sessionId: string, id: string, hash: string) {
    const proposal = this.lspProposal(sessionId, id);
    if (proposal.hash !== hash)
      throw new WorkspaceError('REVISION_CONFLICT', 'LSP proposal content hash changed');
    if (proposal.state !== 'pending') return proposal;
    return this.settleLspProposal(proposal, 'dismissed');
  }

  async applyLspProposal(sessionId: string, id: string, hash: string): Promise<LspProposal> {
    const found = this.lspProposal(sessionId, id);
    if (found.hash !== hash)
      throw new WorkspaceError('REVISION_CONFLICT', 'LSP proposal content hash changed');
    const row = this.worktree(sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'the working copy is unavailable');
    return this.lease(row.worktree_path, async () => {
      const proposal = this.lspProposal(sessionId, id);
      if (proposal.state !== 'pending') return proposal;
      const settlePending = (state: 'stale' | 'applying') => {
        // Dismissal may win while filesystem preflight is awaiting IO.
        this.db
          .prepare("UPDATE lsp_proposals SET state=?,updated_at=? WHERE id=? AND state='pending'")
          .run(state, this.clock.nowIso(), id);
        return this.lspProposal(sessionId, id);
      };
      const active = () =>
        this.hasUnsafeWorktreeOwner(sessionId) ||
        !!this.db
          .prepare(
            "SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('succeeded','failed','cancelled','interrupted') LIMIT 1",
          )
          .get(sessionId);
      if (active())
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          'finish or cancel the session Run or working copy writer before applying this proposal',
        );
      const trusted = () =>
        !!this.db
          .prepare('SELECT 1 FROM workspace_bindings WHERE id=? AND trusted=1')
          .get(row.binding_id);
      if (!trusted())
        throw new WorkspaceError(
          'CAPABILITY_DENIED',
          'trust the repository before applying this proposal',
        );
      const currentCopy = this.worktree(sessionId);
      if (!currentCopy || this.worktreeHash(currentCopy) !== proposal.worktreeHash)
        return settlePending('stale');
      try {
        if ((await this.snapshotTree(row.worktree_path)) !== proposal.tree)
          return settlePending('stale');
        await this.requireLspSnapshot(
          row.worktree_path,
          proposal.tree,
          proposal.source.path,
          proposal.source.sha256,
        );
        await expectFile(
          row.worktree_path,
          safeRelative(proposal.source.path),
          proposal.source.sha256,
        );
        for (const file of proposal.files) {
          if (
            sha256(Buffer.from(file.before)) !== file.beforeHash ||
            sha256(Buffer.from(file.after)) !== file.afterHash
          )
            throw new Error('proposal hash changed');
          await this.requireLspSnapshot(
            row.worktree_path,
            proposal.tree,
            file.path,
            file.beforeHash,
          );
          await expectFile(row.worktree_path, safeRelative(file.path), file.beforeHash);
        }
      } catch {
        return settlePending('stale');
      }
      if (active())
        throw new WorkspaceError(
          'REVISION_CONFLICT',
          'a Run or working copy writer acquired ownership while the proposal was being checked',
        );
      const cancellation: ToolCancellation = {
        get aborted() {
          return active() || !trusted();
        },
        onCancel: () => () => {},
      };
      const outcomes = proposal.outcomes.map((item) => ({ ...item }));
      const claimed = settlePending('applying');
      if (claimed.state !== 'applying') return claimed;
      for (const [index, file] of proposal.files.entries()) {
        try {
          await this.change(
            row.worktree_path,
            sessionId,
            {
              name: 'write_file',
              args: { path: file.path, text: file.after },
              runId: proposal.runId,
              executionId: proposal.executionId,
              toolCallId: proposal.proposalId,
            },
            new Map([[file.path, file.beforeHash]]),
            cancellation,
            file.beforeHash,
          );
          outcomes[index] = { path: file.path, state: 'applied' };
          this.settleLspProposal(proposal, 'applying', outcomes);
        } catch {
          const operation = this.db
            .prepare('SELECT state FROM file_operations WHERE tool_call_id=? AND path=?')
            .get(id, file.path) as { state: string } | undefined;
          const state =
            operation?.state === 'applied'
              ? 'applied'
              : operation?.state === 'planned' || operation?.state === 'uncertain'
                ? 'uncertain'
                : 'failed';
          outcomes[index] = { path: file.path, state };
          return this.settleLspProposal(
            proposal,
            outcomes.some((file) => file.state === 'applied' || file.state === 'uncertain')
              ? 'partial'
              : 'failed',
            outcomes,
          );
        }
      }
      return this.settleLspProposal(proposal, 'applied', outcomes);
    });
  }

  async planCheck(input: CheckExecution, cancellation: ToolCancellation): Promise<CheckPlan> {
    const { row, config, command } = this.checkContext(input);
    if (cancellation.aborted) throw new ToolRefusal('TARGET_TERMINAL', 'check cancelled');
    const plan = await this.lease(row.worktree_path, async () => {
      const tree = await this.snapshotTree(row.worktree_path, input.isolation);
      if (input.expectedTree && tree !== input.expectedTree)
        throw new ToolRefusal('REVISION_CONFLICT', 'Ultra candidate tree changed before its check');
      const launch = await checkLaunchFingerprint(
        row.worktree_path,
        config.revision,
        command,
        input.isolation,
      );
      return {
        commandId: command.id,
        name: command.name,
        argv: command.argv,
        timeoutMs: command.timeoutMs,
        configRevision: config.revision,
        tree,
        fingerprint: launch.fingerprint,
        trusted:
          this.projectTools.trust({
            projectId: config.projectId,
            kind: 'check',
            id: command.id,
            fingerprint: launch.fingerprint,
          }) !== null,
      };
    });
    if (cancellation.aborted) throw new ToolRefusal('TARGET_TERMINAL', 'check cancelled');
    return CheckPlan.parse(plan);
  }

  isolatedChecksAvailable = isolatedChecksAvailable;

  async runCheck(
    input: CheckExecution,
    rawPlan: CheckPlan,
    approvedFingerprint: string | null,
    cancellation: ToolCancellation,
  ): Promise<VerificationReport & { stale: boolean }> {
    const plan = CheckPlan.parse(rawPlan);
    const { sessionId, row, config, command } = this.checkContext(input);
    const now = await this.planCheck(input, cancellation);
    if (
      plan.tree !== now.tree ||
      plan.fingerprint !== now.fingerprint ||
      plan.commandId !== now.commandId ||
      plan.configRevision !== now.configRevision
    )
      throw new ToolRefusal('REVISION_CONFLICT', 'check target tree or launch fingerprint changed');
    if (!now.trusted && approvedFingerprint !== now.fingerprint)
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'check requires trust or exact fingerprint approval',
      );
    const duplicate = this.db
      .prepare(
        `SELECT 1 FROM verifications WHERE json_extract(report_json, '$.owner.runId') = ? AND json_extract(report_json, '$.owner.executionId') = ? AND json_extract(report_json, '$.owner.attemptNo') = ? AND json_extract(report_json, '$.owner.effectId') = ?`,
      )
      .get(input.runId, input.executionId, input.attemptNo, input.effectId);
    if (duplicate) throw new ToolRefusal('CAPABILITY_DENIED', 'this check effect already ran');
    const owner = {
      kind: 'execution' as const,
      runId: input.runId,
      executionId: input.executionId,
      attemptNo: input.attemptNo,
      effectId: input.effectId,
    };
    const id = this.startCheck(
      sessionId,
      config.projectId,
      row.worktree_path,
      command,
      config.revision,
      plan.tree,
      plan.fingerprint,
      owner,
      cancellation,
      approvedFingerprint,
      input.isolation,
    );
    const report = await this.waitVerification(id);
    return {
      ...report,
      stale: (await this.currentTree(sessionId, input.isolation)) !== report.tree,
    };
  }

  private startCheck(
    sessionId: string,
    projectId: string,
    sourceDirectory: string,
    command: RegisteredCheck,
    configRevision: number,
    tree: string,
    fingerprint: string,
    owner: VerificationOwner,
    parentCancellation?: ToolCancellation,
    approvedFingerprint?: string | null,
    isolation?: 'linux-bwrap',
  ): string {
    const id = this.newVerificationId();
    this.db
      .prepare(
        `INSERT INTO verifications (id, session_id, command_id, command_json, tree, exit_code, signal, timed_out, duration_ms, output_tail, state, started_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, NULL, '', 'running', ?, NULL)`,
      )
      .run(id, sessionId, command.id, JSON.stringify(command), tree, this.clock.nowIso());
    const controller = new AbortController();
    const cancellation = {
      get aborted() {
        return controller.signal.aborted;
      },
      onCancel(fn: () => void) {
        controller.signal.addEventListener('abort', fn);
        return () => controller.signal.removeEventListener('abort', fn);
      },
    };
    const off = parentCancellation?.onCancel(() => controller.abort()) ?? (() => {});
    if (parentCancellation?.aborted) controller.abort();
    const completion = this.verificationRunner
      .run(
        {
          verificationId: id,
          ...(isolation ? { isolation } : {}),
          owner,
          sessionId,
          sourceDirectory,
          copyRoot: join(this.worktreeRoot, 'checks'),
          tree,
          configRevision,
          fingerprint,
          command,
          beforeLaunch: async (directory) => {
            if (!this.binding(projectId)?.trusted) throw new Error('repository trust was revoked');
            const current = await checkLaunchFingerprint(
              directory,
              configRevision,
              command,
              isolation,
            );
            if (current.fingerprint !== fingerprint) throw new Error('launch fingerprint changed');
            if (
              owner.kind === 'execution' &&
              approvedFingerprint !== fingerprint &&
              !this.projectTools.trust({ projectId, kind: 'check', id: command.id, fingerprint })
            )
              throw new Error('check launch trust was revoked');
            return current.executable;
          },
        },
        cancellation,
        (report) => {
          const state = ['queued', 'running'].includes(report.state)
            ? 'running'
            : report.verdict === 'pass'
              ? 'passed'
              : report.verdict === 'fail'
                ? 'failed'
                : 'error';
          this.db
            .prepare(
              `UPDATE verifications SET exit_code = ?, signal = ?, timed_out = ?, duration_ms = ?, output_tail = ?, state = ?, ended_at = ?, report_json = ? WHERE id = ? AND session_id = ?`,
            )
            .run(
              report.exitCode,
              report.signal,
              report.timedOut ? 1 : 0,
              report.durationMs,
              report.output.text,
              state,
              report.endedAt,
              JSON.stringify(report),
              id,
              sessionId,
            );
        },
      )
      .finally(() => {
        off();
        this.checks.delete(id);
      });
    this.checks.set(id, { sessionId, cancel: () => controller.abort(), completion });
    void completion.catch(() => {});
    return id;
  }

  async waitVerification(id: string): Promise<VerificationReport> {
    const pending = this.checks.get(id);
    if (pending) return pending.completion;
    const row = this.db.prepare('SELECT report_json FROM verifications WHERE id = ?').get(id) as
      | { report_json: string | null }
      | undefined;
    if (!row?.report_json)
      throw new WorkspaceError('TARGET_NOT_FOUND', 'no such verification report');
    return VerificationReport.parse(JSON.parse(row.report_json));
  }

  cancelVerification(sessionId: string, id: string) {
    const row = this.db
      .prepare('SELECT report_json FROM verifications WHERE id = ? AND session_id = ?')
      .get(id, sessionId) as { report_json: string | null } | undefined;
    if (!row?.report_json)
      throw new WorkspaceError('TARGET_NOT_FOUND', 'no such verification report');
    if (VerificationReport.parse(JSON.parse(row.report_json)).owner.kind !== 'manual')
      throw new WorkspaceError(
        'CAPABILITY_DENIED',
        'stop the owning execution to cancel this check',
      );
    this.checks.get(id)?.cancel();
  }

  async dispose() {
    this.disposing = true;
    await this.terminals.close();
    await this.commandRuntime.close();
    await Promise.allSettled([...this.pendingCommands.values()]);
    await Promise.allSettled(
      [...this.commandServices.values()].map((service) => service.completion),
    );
    const pending = [...this.checks.values()];
    for (const check of pending) check.cancel();
    await Promise.allSettled(pending.map((check) => check.completion));
    // Run termination publishes before its end checkpoint finishes. Keep the DB and
    // working directories alive until those already-owned Git operations have drained.
    await Promise.allSettled([
      ...this.pendingSnapshots.values(),
      ...this.preparingRuns.values(),
      ...this.leases.values(),
    ]);
  }

  /** Updating the desktop must wait for file checkpoints as well as owned processes. */
  hasPendingProcesses(): boolean {
    if (
      this.checks.size ||
      this.pendingCommands.size ||
      this.pendingSnapshots.size ||
      this.preparingRuns.size ||
      this.leases.size ||
      this.workbenchOperations.hasPending()
    )
      return true;
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM command_operations
        WHERE state='running' OR report_json IS NULL OR
        json_extract(report_json,'$.cleanupConfirmed') != 1
        LIMIT 1`)
        .get() ||
        this.db
          .prepare(`SELECT 1 FROM verifications
        WHERE state='running' OR
        (report_json IS NOT NULL AND json_extract(report_json,'$.cleanupConfirmed') != 1)
        LIMIT 1`)
          .get(),
    );
  }

  // ── the file broker (FileTools) ─────────────────────────────────────────────

  private commandContext(input: CommandExecution) {
    if (this.disposing) throw new ToolRefusal('TARGET_TERMINAL', 'workspace is shutting down');
    const found = this.worktreeOfRun(input.runId);
    const access = this.runAccess.get(input.runId);
    if (!found || !access || access.writer !== 1 || access.state !== 'active')
      throw new ToolRefusal('CAPABILITY_DENIED', 'commands require an active working copy writer');
    const binding = this.db
      .prepare('SELECT * FROM workspace_bindings WHERE id=?')
      .get(found.row.binding_id) as BindingRow | undefined;
    if (!binding?.trusted)
      throw new ToolRefusal('CAPABILITY_DENIED', 'trust the repository before running commands');
    if (this.criteria.get(input.runId)?.length)
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'native commands cannot protect immutable review criteria',
      );
    return { ...found, binding };
  }

  /** Caller holds the existing worktree mutex; this does not create a second launch path. */
  private async commandPlanAt(input: CommandExecution): Promise<CommandPlan> {
    const { row, sessionId, binding } = this.commandContext(input);
    const request = RunCommandArgs.parse(input.request);
    const cwd = request.cwd && request.cwd !== '.' ? safeRelative(request.cwd) : '.';
    const root = await realpath(row.worktree_path);
    if (cwd !== '.') await assertPlainPath(root, cwd);
    const directory = await realpath(join(root, cwd));
    if (!(await stat(directory)).isDirectory() || relative(root, directory).startsWith('..'))
      throw new ToolRefusal('CAPABILITY_DENIED', 'command directory is outside the working copy');
    const info = await stat(root);
    const shell = await resolveShellCommand(request.command, request.shellId);
    const hash = (value: unknown) => sha256(Buffer.from(canonicalJson(value)));
    const operationId = `command_${hash({
      runId: input.runId,
      executionId: input.executionId,
      attemptNo: input.attemptNo,
      effectId: input.effectId,
    }).slice(0, 32)}`;
    const plan = {
      operationId,
      hostId: 'local',
      sessionId,
      workspaceBindingId: binding.id,
      worktreeId: `worktree_${sessionId}`,
      rootIdentity: hash({ root, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs }),
      tree: await this.snapshotTree(root),
      shellId: shell.shellId,
      command: request.command,
      executable: shell.executable,
      argv: shell.args,
      cwd,
      environmentHash: hash(commandEnvironment('[command-home]')),
      timeoutMs: request.timeoutMs ?? 120000,
      mode: request.mode ?? 'foreground',
    };
    return CommandPlan.parse({
      ...plan,
      fingerprint: hash({ ...plan, executableHash: sha256(await readFile(shell.executable)) }),
    });
  }

  async planCommand(input: CommandExecution, cancellation: ToolCancellation): Promise<CommandPlan> {
    if (cancellation.aborted) throw new ToolRefusal('TARGET_TERMINAL', 'command cancelled');
    const { row } = this.commandContext(input);
    return this.lease(row.worktree_path, async () => {
      const plan = await this.commandPlanAt(input);
      if (cancellation.aborted) throw new ToolRefusal('TARGET_TERMINAL', 'command cancelled');
      return plan;
    });
  }

  runCommand(
    input: CommandExecution,
    rawPlan: CommandPlan,
    approvedFingerprint: string | null,
    cancellation: ToolCancellation,
  ): Promise<CommandReport> {
    const plan = CommandPlan.parse(rawPlan);
    const requestHash = sha256(Buffer.from(canonicalJson(input)));
    const saved = this.db
      .prepare('SELECT request_hash FROM command_operations WHERE id=?')
      .get(plan.operationId) as { request_hash: string } | undefined;
    if (saved && saved.request_hash !== requestHash)
      return Promise.reject(
        new ToolRefusal('REVISION_CONFLICT', 'command effect identity changed'),
      );
    const existing = this.pendingCommands.get(plan.operationId);
    if (existing) {
      if (this.pendingCommandHashes.get(plan.operationId) !== requestHash)
        return Promise.reject(
          new ToolRefusal('REVISION_CONFLICT', 'command effect identity changed'),
        );
      return existing;
    }
    if (saved) return Promise.resolve(this.commandReport(plan.sessionId, plan.operationId));
    const { row, sessionId } = this.commandContext(input);
    const epoch = this.commandEpochs.get(input.runId) ?? 0;
    const completion = this.lease(row.worktree_path, async () => {
      const current = await this.commandPlanAt(input);
      if (canonicalJson(current) !== canonicalJson(plan))
        throw new ToolRefusal('REVISION_CONFLICT', 'command target or launch identity changed');
      if (approvedFingerprint !== plan.fingerprint) {
        const run = this.db
          .prepare('SELECT snapshot_json FROM runs WHERE id=?')
          .get(input.runId) as { snapshot_json: string };
        if (approvedFingerprint !== null || JSON.parse(run.snapshot_json).permissionMode !== 'auto')
          throw new ToolRefusal('CAPABILITY_DENIED', 'command requires exact launch approval');
      }
      if (
        cancellation.aborted ||
        this.disposing ||
        epoch !== (this.commandEpochs.get(input.runId) ?? 0)
      )
        throw new ToolRefusal('TARGET_TERMINAL', 'command cancelled');
      this.db
        .prepare(`INSERT INTO command_operations
        (id,session_id,run_id,request_hash,owner_json,plan_json,state,report_json,before_tree,after_tree,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'running',NULL,?,NULL,?,?)`)
        .run(
          plan.operationId,
          sessionId,
          input.runId,
          requestHash,
          canonicalJson({
            hostId: plan.hostId,
            sessionId,
            runId: input.runId,
            executionId: input.executionId,
            attemptNo: input.attemptNo,
            effectId: input.effectId,
          }),
          canonicalJson(plan),
          plan.tree,
          this.clock.nowIso(),
          this.clock.nowIso(),
        );
      let lease: ReturnType<CommandRuntime['startService']>;
      try {
        lease = this.commandRuntime.startService(
          {
            operationId: plan.operationId,
            owner: {
              hostId: plan.hostId,
              sessionId,
              runId: input.runId,
              executionId: input.executionId,
              attemptNo: input.attemptNo,
              effectId: input.effectId,
            },
            directory: join(row.worktree_path, plan.cwd),
            command: { shellId: plan.shellId, executable: plan.executable, args: plan.argv },
            timeoutMs: plan.timeoutMs,
          },
          cancellation,
        );
      } catch (error) {
        if (!(error instanceof CommandCapacityError)) throw error;
        const report = CommandReport.parse({
          operationId: plan.operationId,
          state: 'failed',
          exitCode: null,
          signal: null,
          timedOut: false,
          cleanupConfirmed: true,
          output: {
            text: error.message,
            bytes: Buffer.byteLength(error.message),
            hash: sha256(Buffer.from(error.message)),
            truncated: false,
          },
        });
        this.db
          .prepare(
            'UPDATE command_operations SET state=?,report_json=?,after_tree=?,updated_at=? WHERE id=?',
          )
          .run(
            report.state,
            canonicalJson(report),
            plan.tree,
            this.clock.nowIso(),
            plan.operationId,
          );
        return report;
      }
      const finish = async (initial: CommandReport) => {
        let report = initial;
        let after: string | null = null;
        try {
          if (report.cleanupConfirmed) {
            after = await this.snapshotTree(row.worktree_path);
            await this.pin(row.worktree_path, `refs/corral/${sessionId}/latest`, after);
          }
        } catch {
          report = { ...report, state: 'uncertain' };
        }
        if (!report.cleanupConfirmed) this.runAccess.release(input.runId, false);
        this.db
          .prepare(
            'UPDATE command_operations SET state=?,report_json=?,after_tree=?,updated_at=? WHERE id=?',
          )
          .run(report.state, canonicalJson(report), after, this.clock.nowIso(), plan.operationId);
        return CommandReport.parse(report);
      };
      if (plan.mode === 'service') {
        // Keep the run's durable writer reservation, but free the per-operation mutex
        // so the same run can edit and rebuild while its development server is alive.
        const completion = lease.completion.then((report) =>
          this.lease(row.worktree_path, () => finish(report)),
        );
        this.commandServices.set(plan.operationId, {
          runId: input.runId,
          started: lease.started,
          completion,
        });
        void completion.catch(() => this.runAccess.release(input.runId, false));
        return CommandReport.parse({
          operationId: plan.operationId,
          state: 'running',
          exitCode: null,
          signal: null,
          timedOut: false,
          cleanupConfirmed: false,
          output: { text: '', bytes: 0, hash: sha256(Buffer.alloc(0)), truncated: false },
        });
      }
      return finish(await lease.completion);
    }).then(async (report) => {
      const service = this.commandServices.get(plan.operationId);
      if (report.state === 'running' && service && !(await service.started))
        return service.completion;
      return report;
    });
    this.pendingCommands.set(plan.operationId, completion);
    this.pendingCommandRuns.set(plan.operationId, input.runId);
    this.pendingCommandHashes.set(plan.operationId, requestHash);
    void completion
      .finally(() => {
        this.pendingCommands.delete(plan.operationId);
        this.pendingCommandHashes.delete(plan.operationId);
        this.pendingCommandRuns.delete(plan.operationId);
      })
      .catch(() => {});
    return completion;
  }

  listCommandShells() {
    return listShells().then((shells) => shells.map(({ id, label }) => ({ id, label })));
  }

  listCommands(sessionId: string) {
    return this.db
      .prepare(`SELECT id,run_id,plan_json,state,before_tree,after_tree,created_at,updated_at
      FROM command_operations WHERE session_id=? ORDER BY created_at DESC LIMIT 100`)
      .all(sessionId)
      .map((raw) => {
        const row = raw as {
          id: string;
          run_id: string;
          plan_json: string;
          state: string;
          before_tree: string;
          after_tree: string | null;
          created_at: string;
          updated_at: string;
        };
        const plan = CommandPlan.parse(JSON.parse(row.plan_json));
        const { plan_json: _private, ...publicRow } = row;
        return {
          ...publicRow,
          shellId: plan.shellId,
          cwd: plan.cwd,
          mode: plan.mode,
          command: plan.command ?? null,
        };
      });
  }

  commandReport(sessionId: string, operationId: string): CommandReport {
    const row = this.db
      .prepare('SELECT state,report_json FROM command_operations WHERE id=? AND session_id=?')
      .get(operationId, sessionId) as { state: string; report_json: string | null } | undefined;
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'command operation is unavailable');
    if (row.report_json) return CommandReport.parse(JSON.parse(row.report_json));
    return CommandReport.parse({
      operationId,
      state: row.state === 'running' ? 'running' : 'uncertain',
      exitCode: null,
      signal: null,
      timedOut: false,
      cleanupConfirmed: false,
      output: {
        text:
          row.state === 'running'
            ? ''
            : '[The host stopped before this command was confirmed. It was not replayed.]',
        bytes: 0,
        hash: sha256(Buffer.alloc(0)),
        truncated: false,
      },
    });
  }

  readCommandOutput(sessionId: string, operationId: string, offset = 0) {
    const row = this.db
      .prepare('SELECT id FROM command_operations WHERE id=? AND session_id=?')
      .get(operationId, sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'command operation is unavailable');
    const live = this.commandRuntime.read(operationId, offset);
    if (live) return live;
    const report = this.commandReport(sessionId, operationId);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new WorkspaceError('SCHEMA_INVALID', 'invalid offset');
    const text = report.output.text.slice(offset, offset + 8192);
    return {
      text,
      nextOffset: offset + text.length,
      bytes: report.output.bytes,
      truncated: report.output.truncated,
    };
  }

  async stopCommand(sessionId: string, operationId: string) {
    const row = this.db
      .prepare('SELECT id FROM command_operations WHERE id=? AND session_id=?')
      .get(operationId, sessionId);
    if (!row) throw new WorkspaceError('TARGET_NOT_FOUND', 'command operation is unavailable');
    await this.commandRuntime.stop(operationId);
    await this.pendingCommands.get(operationId);
    await this.commandServices.get(operationId)?.completion;
    return this.commandReport(sessionId, operationId);
  }

  async stopRunServices(runId: string): Promise<void> {
    this.commandEpochs.set(runId, (this.commandEpochs.get(runId) ?? 0) + 1);
    // Include commands whose native helper is still starting. A completed report is
    // retained for repeat stop requests and late lifecycle callbacks.
    const owned = this.db
      .prepare(
        "SELECT id FROM command_operations WHERE run_id=? AND state IN ('running','uncertain')",
      )
      .all(runId) as { id: string }[];
    for (const row of owned) await this.commandRuntime.stop(row.id);
    for (const row of owned) {
      await this.pendingCommands.get(row.id);
      await this.commandServices.get(row.id)?.completion;
    }
    await Promise.allSettled(
      [...this.pendingCommandRuns]
        .filter(([, owner]) => owner === runId)
        .map(([operationId]) => this.pendingCommands.get(operationId)),
    );
    const unfinished = this.db
      .prepare(
        "SELECT 1 FROM command_operations WHERE run_id=? AND (state='running' OR report_json IS NULL OR json_extract(report_json,'$.cleanupConfirmed')!=1) LIMIT 1",
      )
      .get(runId);
    if (unfinished) {
      this.runAccess.release(runId, false);
      throw new ToolTerminationUnconfirmed();
    }
  }

  attestCommandConnection(sessionId: string, operationId: string, port: number, peerPort: number) {
    const row = this.db
      .prepare("SELECT id FROM command_operations WHERE id=? AND session_id=? AND state='running'")
      .get(operationId, sessionId);
    return row
      ? this.commandRuntime.attestConnection(operationId, port, peerPort)
      : Promise.resolve(false);
  }

  private worktreeOfRun(runId: string): { row: WorktreeRow; sessionId: string } | null {
    const sessionId = this.sessionOfRun(runId);
    if (!sessionId) return null;
    const row = this.worktree(sessionId);
    return row ? { row, sessionId } : null;
  }

  available(runId: string): boolean {
    return this.worktreeOfRun(runId) !== null;
  }

  acquireRun(runId: string, sessionId: string | undefined, writer: boolean): void {
    if (sessionId && this.removingWorktrees.has(sessionId))
      throw new ToolRefusal('REVISION_CONFLICT', 'the working copy is being removed');
    const row = sessionId ? this.worktree(sessionId) : null;
    if (row)
      this.runAccess.acquire(runId, row.session_id, row.worktree_path, writer, row.copy_generation);
  }

  worktreeScope(sessionId: string): string | null {
    const row = this.worktree(sessionId);
    if (!row) return null;
    const path = realpathSync.native(row.worktree_path);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  }

  hasUnsafeWorktreeOwner(sessionId: string): boolean {
    const key = this.worktreeScope(sessionId);
    return key !== null && this.runAccess.writerAt(key) !== undefined;
  }

  prepareRun(runId: string): Promise<void> {
    const pending = this.preparingRuns.get(runId);
    if (pending) return pending;
    const access = this.runAccess.get(runId);
    if (!access || (access.tree && this.runTree(runId, 'start'))) return Promise.resolve();
    const row = this.worktree(access.session_id);
    if (!row)
      return Promise.reject(new ToolRefusal('TARGET_NOT_FOUND', 'working copy is unavailable'));
    const work = this.lease(row.worktree_path, async () => {
      const writer = this.runAccess.writerAt(access.worktree_key);
      // A concurrent reader observes the writer's pinned input, never partially written files.
      const tree =
        this.runAccess.get(runId)?.tree ||
        (!access.writer && writer?.tree) ||
        (await this.snapshotTree(row.worktree_path));
      await this.pin(
        row.worktree_path,
        `refs/corral/${access.session_id}/runs/${runId}/start`,
        tree,
      );
      this.runAccess.pin(runId, tree);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO run_snapshots(run_id,phase,session_id,tree,captured_at) VALUES(?,'start',?,?,?)",
        )
        .run(runId, access.session_id, tree, this.clock.nowIso());
      await this.checkpointAt(row, {
        checkpointId: `checkpoint_${sha256(Buffer.from(`${runId}:start`)).slice(0, 32)}`,
        label: 'Before Run',
        kind: 'before_run',
        runId,
        tree,
        pinned: false,
      });
    });
    this.preparingRuns.set(runId, work);
    const settled = () => {
      if (this.preparingRuns.get(runId) === work) this.preparingRuns.delete(runId);
    };
    void work.then(settled, settled);
    return work;
  }

  async startBaseline(runId: string): Promise<string | null> {
    await this.prepareRun(runId);
    return this.runAccess.get(runId)?.tree ?? this.runTree(runId, 'start');
  }

  /** Preview assets for reader Runs come from the same immutable tree as their file tools. */
  async readPreviewSnapshot(runId: string, path: string): Promise<Buffer | null> {
    const access = this.runAccess.get(runId);
    if (access && access.state !== 'active')
      throw new ToolRefusal('TARGET_TERMINAL', 'run file access is no longer active');
    if (!access || access.writer) return null;
    await this.prepareRun(runId);
    const tree = this.runAccess.get(runId)?.tree;
    const row = this.worktree(access.session_id);
    if (!tree || !row) throw new ToolRefusal('TARGET_NOT_FOUND', 'run input snapshot unavailable');
    const rel = safeRelative(path);
    const entries = (
      await git(row.worktree_path, ['ls-tree', '-r', '-z', '-l', tree, '--', `:(literal)${rel}`])
    ).stdout
      .toString('utf8')
      .split('\0');
    const entry = entries
      .map((line) => /^100(?:644|755) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(line))
      .find((match) => match?.[3] === rel);
    if (!entry?.[1])
      throw new ToolRefusal('TARGET_NOT_FOUND', 'asset not present in the run snapshot');
    if (Number(entry[2]) > 8 * 1024 * 1024)
      throw new ToolRefusal('LIMIT_REACHED', 'preview asset exceeds 8 MiB');
    return (
      await git(row.worktree_path, ['cat-file', 'blob', entry[1]], {
        maxBuffer: 8 * 1024 * 1024 + 1,
      })
    ).stdout;
  }

  releaseRun(runId: string, terminationConfirmed: boolean): void {
    this.runAccess.release(runId, terminationConfirmed);
    this.preparingRuns.delete(runId);
  }

  /** Call only after the adapter has positively recovered every prior worker/process group. */
  confirmWorkerRecovery(): void {
    this.db
      .prepare(`UPDATE workspace_access SET state='released'
      WHERE owner_kind='run' AND state='uncertain'
        AND NOT EXISTS (SELECT 1 FROM command_operations c
          WHERE c.run_id=workspace_access.owner_id AND c.state IN ('running','uncertain'))
        AND NOT EXISTS (SELECT 1 FROM file_operations f
          WHERE f.session_id=workspace_access.session_id AND f.state IN ('planned','uncertain'))
        AND NOT EXISTS (SELECT 1 FROM checkpoint_restores r
          WHERE r.session_id=workspace_access.session_id
            AND json_extract(r.result_json,'$.state') IN ('applying','partial','uncertain'))`)
      .run();
  }

  async readPinnedRun(
    input: {
      name: string;
      args: Record<string, unknown>;
      runId: string;
      executionId: string;
      attemptNo?: number;
    },
    cancellation: ToolCancellation,
  ): Promise<Record<string, unknown> | null> {
    const access = this.runAccess.get(input.runId);
    if (cancellation.aborted || (access && access.state !== 'active'))
      throw new ToolRefusal('TARGET_TERMINAL', 'run file access is no longer active');
    if (!access || access.writer) return null;
    if (!['list_files', 'read_file', 'read_hashline'].includes(input.name))
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'a snapshot reader cannot be promoted to a writer',
      );
    await this.prepareRun(input.runId);
    const tree = this.runAccess.get(input.runId)?.tree;
    const row = this.worktree(access.session_id);
    if (!tree || !row) throw new ToolRefusal('TARGET_NOT_FOUND', 'run input snapshot unavailable');
    const root = row.worktree_path;
    const path = input.args.path ? safeRelative(String(input.args.path)) : '';
    const listing = (await git(root, ['ls-tree', '-r', '-z', '-l', tree])).stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .flatMap((line) => {
        const match = /^100(?:644|755) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(line);
        return match ? [{ oid: match[1]!, bytes: Number(match[2]), path: match[3]! }] : [];
      });
    if (input.name === 'list_files') {
      const files = listing.filter((file) => !path || file.path.startsWith(`${path}/`));
      return {
        files: files.slice(0, 500).map(({ path, bytes }) => ({ path, bytes })),
        truncated: files.length > 500,
      };
    }
    const file = listing.find((file) => file.path === path);
    if (!file) throw new ToolRefusal('TARGET_NOT_FOUND', 'file not present in the run snapshot');
    if (file.bytes > MAX_TEXT) throw new ToolRefusal('LIMIT_REACHED', 'file exceeds 1 MiB');
    const bytes = (await git(root, ['cat-file', 'blob', file.oid], { maxBuffer: MAX_TEXT + 1 }))
      .stdout;
    if (input.name === 'read_hashline') {
      const { evidence: _evidence, ...display } = this.hashlineRead(input, bytes, path);
      return display;
    }
    const text = decodeText(bytes);
    if (text === null) throw new ToolRefusal('CAPABILITY_DENIED', 'file is not UTF-8 text');
    const hash = sha256(bytes);
    this.readsOf(input.runId, input.executionId).set(path, hash);
    return { path, text, sha256: hash };
  }

  runStartFiles(runId: string): import('@corral/contracts').RuntimeFiles | null {
    const source = this.worktreeOfRun(runId);
    const checkpoint = source
      ? this.checkpoints(source.sessionId).find(
          (item) => item.runId === runId && item.kind === 'before_run' && item.state === 'ready',
        )
      : undefined;
    return checkpoint?.tree && checkpoint.manifestHash
      ? {
          checkpointId: checkpoint.checkpointId,
          manifestHash: checkpoint.manifestHash,
          tree: checkpoint.tree,
        }
      : null;
  }

  async branchRuntimeFiles(
    sourceRunId: string,
    reference: import('@corral/contracts').RuntimeFiles,
    sessionId: string,
  ): Promise<string> {
    const source = this.worktreeOfRun(sourceRunId);
    if (!source)
      throw new WorkspaceError('TARGET_NOT_FOUND', 'the source working copy is unavailable');
    const row = await this.checkpointTarget(source.sessionId, 'working_copy');
    const checkpoint = this.checkpoints(source.sessionId).find(
      (item) => item.checkpointId === reference.checkpointId,
    );
    if (
      !checkpoint ||
      checkpoint.runId !== sourceRunId ||
      checkpoint.state !== 'ready' ||
      checkpoint.tree !== reference.tree ||
      checkpoint.manifestHash !== reference.manifestHash ||
      (checkpoint.target ?? 'working_copy') !== 'working_copy' ||
      (await gitText(row.worktree_path, [
        'rev-parse',
        this.checkpointRef(source.sessionId, reference.checkpointId),
      ])) !== reference.tree
    )
      throw new WorkspaceError('REVISION_CONFLICT', 'the source checkpoint changed');
    const binding = this.db
      .prepare('SELECT project_id FROM workspace_bindings WHERE id=?')
      .get(row.binding_id) as { project_id: string };
    const target = this.db
      .prepare('SELECT project_id FROM work_sessions WHERE id=?')
      .get(sessionId) as { project_id: string } | undefined;
    if (!target || target.project_id !== binding.project_id || sessionId === source.sessionId)
      throw new WorkspaceError(
        'CAPABILITY_DENIED',
        'a branch requires a separate session in the same project',
      );
    const checkpointId = `branch_${reference.checkpointId}`;
    const finishBaseline = async () => {
      const target = this.worktree(sessionId)!;
      await this.lease(target.worktree_path, async () => {
        if ((await this.snapshotTree(target.worktree_path)) !== reference.tree)
          throw new WorkspaceError(
            'REVISION_CONFLICT',
            'the new branch was edited before its baseline was fixed',
          );
        await this.pin(target.worktree_path, `refs/corral/${sessionId}/base`, reference.tree);
        this.db
          .prepare('UPDATE session_worktrees SET base_tree=? WHERE session_id=?')
          .run(reference.tree, sessionId);
      });
      return reference.tree;
    };
    if (this.worktree(sessionId)) {
      const existing = this.checkpoints(sessionId).find(
        (item) => item.checkpointId === checkpointId,
      );
      if (
        existing?.tree === reference.tree &&
        existing.state === 'ready' &&
        (await this.currentTree(sessionId)) === reference.tree
      )
        return finishBaseline();
      throw new WorkspaceError(
        'REVISION_CONFLICT',
        'the branch working copy already exists or is incomplete',
      );
    }
    await this.createWorktree(sessionId, binding.project_id, row.base_commit);
    const copy = await this.checkpointTarget(sessionId, 'working_copy');
    const saved = await this.lease(copy.worktree_path, () =>
      this.checkpointAt(copy, {
        checkpointId,
        label: 'Message branch baseline',
        kind: 'manual',
        tree: reference.tree,
        pinned: true,
      }),
    );
    const plan = await this.planCheckpointRestore(sessionId, checkpointId, saved.manifestHash!);
    const restored = await this.restoreCheckpoint(sessionId, {
      operationId: `restore_${checkpointId}`,
      checkpointId,
      manifestHash: saved.manifestHash!,
      expectedTree: plan.expectedTree,
    });
    if (restored.state !== 'applied')
      throw new WorkspaceError('REVISION_CONFLICT', 'the branch working copy is incomplete');
    return finishBaseline();
  }

  async captureRuntimeFiles(
    runId: string,
    checkpointId: string,
  ): Promise<import('@corral/contracts').RuntimeFiles> {
    const found = this.worktreeOfRun(runId);
    if (!found) throw new ToolRefusal('CAPABILITY_DENIED', 'runtime files require a working copy');
    const row = await this.checkpointTarget(found.sessionId, 'working_copy');
    return this.lease(row.worktree_path, async () => {
      const checkpoint = await this.checkpointAt(row, {
        checkpointId,
        runId,
        label: 'Runtime boundary',
        kind: 'runtime',
        pinned: true,
        ...(this.runAccess.get(runId)?.writer === 0
          ? { tree: this.runAccess.get(runId)?.tree ?? undefined }
          : {}),
      });
      if (!checkpoint.tree || !checkpoint.manifestHash) throw new Error('runtime files incomplete');
      return { checkpointId, manifestHash: checkpoint.manifestHash, tree: checkpoint.tree };
    });
  }

  async verifyRuntimeFiles(
    runId: string,
    reference: import('@corral/contracts').RuntimeFiles,
  ): Promise<boolean> {
    const found = this.worktreeOfRun(runId);
    if (!found) return false;
    const row = await this.checkpointTarget(found.sessionId, 'working_copy');
    return this.lease(row.worktree_path, async () => {
      const checkpoint = this.checkpoints(found.sessionId).find(
        (item) => item.checkpointId === reference.checkpointId,
      );
      if (
        !checkpoint ||
        checkpoint.runId !== runId ||
        checkpoint.state !== 'ready' ||
        checkpoint.manifestHash !== reference.manifestHash ||
        checkpoint.tree !== reference.tree ||
        checkpoint.target !== 'working_copy'
      )
        return false;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM file_operations WHERE session_id=? AND state IN ('planned','uncertain') LIMIT 1",
          )
          .get(found.sessionId) ||
        this.checkpointRestores(found.sessionId).some((item) =>
          ['applying', 'partial', 'uncertain'].includes(item.state),
        )
      )
        return false;
      const pinned = await git(row.worktree_path, [
        'rev-parse',
        this.checkpointRef(found.sessionId, reference.checkpointId),
      ]);
      return (
        pinned.stdout.toString('utf8').trim() === reference.tree &&
        (this.runAccess.get(runId)?.writer === 0
          ? this.runAccess.get(runId)?.tree === reference.tree
          : (await this.snapshotTree(row.worktree_path)) === reference.tree)
      );
    });
  }

  async currentTreeForRun(runId: string, isolation?: 'linux-bwrap'): Promise<string | null> {
    const access = this.runAccess.get(runId);
    if (access?.writer === 0) return this.startBaseline(runId);
    const found = this.worktreeOfRun(runId);
    return found ? this.currentTree(found.sessionId, isolation) : null;
  }

  async pinCriteria(runId: string, raw: ReviewRecipeRevision['criteriaFiles']) {
    const files = ReviewRecipeRevision.shape.criteriaFiles.parse(raw);
    const found = this.worktreeOfRun(runId);
    if (!found) throw new ToolRefusal('CAPABILITY_DENIED', 'criteria require a working copy');
    await this.lease(found.row.worktree_path, async () => {
      const current = this.criteria.get(runId);
      if (current && canonicalJson(current) !== canonicalJson(files))
        throw new ToolRefusal('REVISION_CONFLICT', 'recipe criteria are already pinned');
      for (const file of files)
        if (
          sha256(await textBytes(found.row.worktree_path, safeRelative(file.path))) !== file.sha256
        )
          throw new ToolRefusal('REVISION_CONFLICT', 'recipe criteria changed');
      this.criteria.set(runId, files);
    });
  }

  async validateCriteria(runId: string): Promise<boolean> {
    const files = this.criteria.get(runId);
    if (!files) return false;
    const found = this.worktreeOfRun(runId);
    if (!found) return false;
    try {
      for (const file of files)
        if (
          sha256(await textBytes(found.row.worktree_path, safeRelative(file.path))) !== file.sha256
        )
          return false;
      return true;
    } catch {
      return false;
    }
  }

  private lease<T>(worktree: string, work: () => Promise<T>): Promise<T> {
    const previous = this.leases.get(worktree) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = () => {
      if (this.leases.get(worktree) === tail) this.leases.delete(worktree);
    };
    const tail = next.then(settled, settled);
    this.leases.set(worktree, tail);
    return next;
  }

  private readsOf(runId: string, executionId: string) {
    const executions = this.reads.get(runId) ?? new Map<string, Map<string, string>>();
    this.reads.set(runId, executions);
    const map = executions.get(executionId) ?? new Map<string, string>();
    executions.set(executionId, map);
    return map;
  }

  private hashlineScope(input: {
    runId: string;
    executionId: string;
    attemptNo?: number;
  }): HashlineScope {
    const row = this.db.prepare('SELECT projection_json FROM runs WHERE id = ?').get(input.runId) as
      | { projection_json: string }
      | undefined;
    const projection = row
      ? (JSON.parse(row.projection_json) as {
          executions?: Record<string, { attemptNo?: number }>;
        })
      : undefined;
    const attempt = projection?.executions?.[input.executionId]?.attemptNo;
    if (!Number.isSafeInteger(attempt) || (attempt ?? 0) < 1)
      throw new ToolRefusal('TARGET_NOT_FOUND', 'Hashline execution attempt is unavailable');
    if (input.attemptNo !== attempt)
      throw new ToolRefusal('REVISION_CONFLICT', 'Hashline caller attempt is no longer current');
    return {
      hostId: 'local',
      runId: input.runId,
      executionId: input.executionId,
      attempt: attempt as number,
    };
  }

  private hashlineRead(
    input: {
      runId: string;
      executionId: string;
      attemptNo?: number;
      args: Record<string, unknown>;
    },
    bytes: Uint8Array,
    path: string,
  ) {
    try {
      const { offset, limit } = input.args;
      if (
        (offset !== undefined && typeof offset !== 'number') ||
        (limit !== undefined && typeof limit !== 'number')
      )
        throw new ToolRefusal(
          'SCHEMA_INVALID',
          'Hashline offset and limit must be positive integers',
        );
      return readHashline({
        bytes,
        path,
        scope: this.hashlineScope(input),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
        maxOutputBytes: MAX_TEXT + 4096,
      });
    } catch (error) {
      if (error instanceof HashlineError) throw new ToolRefusal(error.code, error.message);
      throw error;
    }
  }

  async execute(
    input: {
      name: BrokerFileToolName;
      args: Record<string, unknown>;
      runId: string;
      executionId: string;
      attemptNo?: number;
      toolCallId: string;
    },
    cancellation: ToolCancellation,
  ): Promise<Record<string, unknown>> {
    const frozen = await this.readPinnedRun(input, cancellation);
    if (frozen) return frozen;
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
      case 'read_hashline': {
        if (cancellation.aborted)
          throw new ToolRefusal('TARGET_TERMINAL', 'the task was cancelled');
        const path = safeRelative(String(input.args.path));
        const bytes = await textBytes(root, path);
        const { evidence, ...display } = this.hashlineRead(input, bytes, path);
        if (cancellation.aborted)
          throw new ToolRefusal('TARGET_TERMINAL', 'the task was cancelled');
        const entries = this.hashlineReads.get(input.runId) ?? new Map<string, HashlineEvidence>();
        const key = JSON.stringify([input.executionId, path]);
        entries.set(key, mergeHashlineEvidence(entries.get(key), evidence));
        this.hashlineReads.set(input.runId, entries);
        return display;
      }
      case 'edit_hashline': {
        const args = HashlineEditInput.parse(input.args);
        const path = safeRelative(args.path);
        return this.lease(root, async () => {
          if (cancellation.aborted)
            throw new ToolRefusal('TARGET_TERMINAL', 'the task was cancelled');
          const entries = this.hashlineReads.get(input.runId);
          const key = JSON.stringify([input.executionId, path]);
          let plan: ReturnType<typeof applyHashline>;
          try {
            plan = applyHashline({
              bytes: await textBytes(root, path),
              path,
              scope: this.hashlineScope(input),
              evidence: entries?.get(key),
              tag: args.tag,
              ops: args.ops,
            });
          } catch (error) {
            if (error instanceof HashlineError) throw new ToolRefusal(error.code, error.message);
            throw error;
          }
          const change =
            plan.kind === 'write'
              ? { name: 'write_file' as const, args: { path, text: plan.bytes.toString('utf8') } }
              : plan.kind === 'delete'
                ? { name: 'delete_file' as const, args: { path } }
                : { name: 'move_file' as const, args: { from: path, to: plan.to } };
          // Keep the evidence recheck and journaled mutation inside the same lease.
          // No individual textual operation has been applied before this point.
          const applied = await this.change(
            root,
            found.sessionId,
            { ...input, ...change },
            reads,
            cancellation,
            plan.beforeSha256,
            () => {
              this.hashlineScope(input);
            },
          );
          entries?.delete(key);
          // A partial Hashline read/edit must not become a whole-file Pi write grant.
          reads.delete(path);
          if (plan.kind === 'move') {
            entries?.delete(JSON.stringify([input.executionId, plan.to]));
            reads.delete(plan.to);
          }
          return {
            ...applied,
            version: 1,
            tag: plan.tag,
            ops: plan.ops,
            ...(plan.firstChangedLine === undefined
              ? {}
              : { firstChangedLine: plan.firstChangedLine }),
          };
        });
      }
      case 'edit': {
        const args = PiEditInput.parse(input.args);
        return this.lease(root, async () => {
          const before = await this.requireRead(root, args.path, reads);
          const bytes = await textBytes(root, args.path);
          if (bytes.length > MAX_TEXT)
            throw new ToolRefusal('LIMIT_REACHED', 'files are at most 1 MiB');
          if (sha256(bytes) !== before)
            throw new ToolRefusal('CAPABILITY_DENIED', `${args.path} changed since it was read`);
          const text = decodeText(bytes, true);
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
            before,
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
        const bytes = await textBytes(root, rel);
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
    const current = sha256(await textBytes(root, rel));
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
    expectedBefore?: string,
    validateAttempt?: () => void,
  ): Promise<Record<string, unknown>> {
    const now = () => this.clock.nowIso();
    const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
    const targets = (
      input.name === 'move_file' ? [input.args.from, input.args.to] : [input.args.path]
    ).map((path) => key(safeRelative(String(path))));
    if (this.criteria.get(input.runId)?.some((file) => targets.includes(key(file.path))))
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'recipe criteria files are immutable during this run',
      );
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
    const settle = (state: 'applied' | 'failed' | 'uncertain', detail: string | null = null) =>
      this.db
        .prepare('UPDATE file_operations SET state = ?, detail = ?, updated_at = ? WHERE id = ?')
        .run(state, detail, now(), opId);
    const guard = () => {
      if (cancellation.aborted) throw new ToolRefusal('TARGET_TERMINAL', 'the task was cancelled');
      validateAttempt?.();
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
      if (expectedBefore !== undefined) await expectFile(root, rel, expectedBefore);
      const before =
        expectedBefore ?? (kind === 'file' ? await this.requireRead(root, rel, reads) : null);
      const after = sha256(bytes);
      guard();
      plan('write', rel, null, before, after);
      let applied = false;
      let temporary: string | undefined;
      try {
        const full = join(root, rel);
        await mkdir(dirname(full), { recursive: true });
        await expectFile(root, rel, before);
        const mode = kind === 'file' ? (await stat(full)).mode : 0o644;
        temporary = join(dirname(full), `.${basename(full)}.corral-${randomUUID().slice(0, 8)}`);
        await this.io.writeFile(temporary, bytes, { mode, flag: 'wx' });
        await expectFile(root, rel, before);
        guard();
        // link is exclusive for a new destination; rename replaces only a checked existing file.
        if (before === null) await this.io.link(temporary, full);
        else await this.io.rename(temporary, full);
        applied = true;
        settle('applied');
      } catch (error) {
        try {
          settle(
            applied ? 'uncertain' : 'failed',
            applied ? 'file changed but recording was not confirmed' : 'write did not complete',
          );
        } catch {
          /* A planned row becomes uncertain on recovery. */
        }
        if (error instanceof ToolRefusal) throw error;
        throw new ToolRefusal(
          'CAPABILITY_DENIED',
          applied ? `the change to ${rel} could not be recorded` : `could not write ${rel}`,
        );
      } finally {
        if (temporary) await rm(temporary, { force: true });
      }
      reads.set(rel, after);
      return { path: rel, sha256: after, bytes: bytes.length, created: kind === 'missing' };
    }

    if (input.name === 'delete_file') {
      const rel = safeRelative(String(input.args.path));
      if ((await assertPlainPath(root, rel)) !== 'file')
        throw new ToolRefusal('TARGET_NOT_FOUND', `${rel} is not a file`);
      const before = expectedBefore ?? (await this.requireRead(root, rel, reads));
      if (expectedBefore !== undefined) await expectFile(root, rel, expectedBefore);
      guard();
      plan('delete', rel, null, before, null);
      let applied = false;
      try {
        await expectFile(root, rel, before);
        guard();
        await this.io.unlink(join(root, rel));
        applied = true;
        settle('applied');
      } catch (error) {
        try {
          settle(
            applied ? 'uncertain' : 'failed',
            applied ? 'file changed but recording was not confirmed' : 'delete did not complete',
          );
        } catch {
          /* Recovered as uncertain. */
        }
        if (error instanceof ToolRefusal) throw error;
        throw new ToolRefusal('CAPABILITY_DENIED', `could not confirm deletion of ${rel}`);
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
    const before = expectedBefore ?? (await this.requireRead(root, from, reads));
    if (expectedBefore !== undefined) await expectFile(root, from, expectedBefore);
    guard();
    plan('move', from, to, before, before);
    let applied = false;
    try {
      await mkdir(dirname(join(root, to)), { recursive: true });
      await expectFile(root, from, before);
      await expectFile(root, to, null);
      guard();
      await this.io.rename(join(root, from), join(root, to));
      applied = true;
      settle('applied');
    } catch (error) {
      try {
        settle(
          applied ? 'uncertain' : 'failed',
          applied ? 'file changed but recording was not confirmed' : 'move did not complete',
        );
      } catch {
        /* Recovered as uncertain. */
      }
      if (error instanceof ToolRefusal) throw error;
      throw new ToolRefusal('CAPABILITY_DENIED', `could not confirm movement of ${from}`);
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
