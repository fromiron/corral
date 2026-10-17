import type {
  ChangeScopeQuery,
  ChangeSetView,
  FileChangeView,
  FileOperationView,
  FileSideView,
  InboxItemView,
  IntegrationPlanFile,
  IntegrationResultView,
  ReviewCommentView,
  ReviewDecisionView,
  VerificationResultView,
  WorkspaceBindingView,
  WorktreeView,
} from '@corral/client';
import { type FileTools, type RunStore, type ToolCancellation, ToolRefusal } from '@corral/core';
import { diffLines } from '@corral/react/diff';

// The browser demo's work folder (02-UX-Spec §10): the same flow as the local server's
// (CR-012, CR-013) on files kept in memory, so the demo shows multi-file changes, review,
// decisions, applying and reverting without a server. A page reload starts it again, as it
// does demo runs. Checks run commands, which a browser cannot: they say so.

type Files = Map<string, string>;

/** Paths as the server's broker accepts them: relative, inside, never .git or .corral. */
function safeRelative(input: string): string {
  if (!input || input.includes('\0') || input.includes('\\') || input.startsWith('/'))
    throw new ToolRefusal('SCHEMA_INVALID', 'use a relative path with / separators');
  const parts = input.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) throw new ToolRefusal('SCHEMA_INVALID', 'the path names no file');
  if (parts.some((p) => p === '..'))
    throw new ToolRefusal('CAPABILITY_DENIED', 'paths may not leave the working copy');
  if (parts.some((p) => p.toLowerCase() === '.git' || p.toLowerCase() === '.corral'))
    throw new ToolRefusal('CAPABILITY_DENIED', 'that folder is not part of the working copy');
  return parts.join('/');
}

/** A stable 40-hex id for content (not cryptographic: the demo has nothing to protect). */
function contentId(text: string): string {
  let out = '';
  for (let seed = 0; seed < 5; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

const treeId = (files: Files) =>
  contentId(
    [...files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, text]) => `${path}\0${contentId(text)}`)
      .join('\n'),
  );

const EXAMPLE_FOLDER: [string, string][] = [
  ['README.md', '# Release notes\n\nNotes for each version live in `notes/`.\n'],
  ['notes/1.3.md', '# 1.3\n\n- Faster start\n- Fixed the export dialog\n'],
  ['src/version.ts', "export const VERSION = '1.3.0';\n"],
];

interface Binding {
  bindingId: string;
  projectId: string;
  trusted: boolean;
  head: Files;
  folder: Files;
}

interface Copy {
  bindingId: string;
  files: Files;
  baseTree: string;
  reviewedTree: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export class DemoWorkspace implements FileTools {
  private readonly store: RunStore;
  private readonly bindings = new Map<string, Binding>();
  private readonly copies = new Map<string, Copy>();
  private readonly trees = new Map<string, Files>();
  private readonly runTrees = new Map<
    string,
    { sessionId: string; start?: string; end?: string }
  >();
  private readonly reads = new Map<string, Map<string, string>>();
  private readonly ops: (FileOperationView & { sessionId: string })[] = [];
  private readonly comments: (ReviewCommentView & { sessionId: string })[] = [];
  private readonly decisionsList: (Omit<ReviewDecisionView, 'stale'> & { sessionId: string })[] =
    [];
  private readonly integrationsList: (IntegrationResultView & {
    sessionId: string;
    from: string;
    to: string;
  })[] = [];
  private next = 0;

  constructor(store: RunStore) {
    this.store = store;
  }

  private id(prefix: string) {
    this.next += 1;
    return `${prefix}_demo${String(this.next).padStart(4, '0')}`;
  }

  private keep(files: Files): string {
    const id = treeId(files);
    if (!this.trees.has(id)) this.trees.set(id, new Map(files));
    return id;
  }

  // ── folder ──────────────────────────────────────────────────────────────────

  binding(projectId: string): WorkspaceBindingView | null {
    const b = this.bindings.get(projectId);
    if (!b) return null;
    const changed = [...new Set([...b.head.keys(), ...b.folder.keys()])].filter(
      (p) => b.head.get(p) !== b.folder.get(p),
    ).length;
    return {
      bindingId: b.bindingId,
      projectId,
      path: 'demo://example-repo',
      isGit: true,
      trusted: b.trusted,
      verifyCommands: [],
      status: { branch: 'main', head: treeId(b.head).slice(0, 7), changed },
      missing: false,
    };
  }

  /** Any path links the same example folder: the demo has no disk to read. */
  bind(projectId: string, _path: string): WorkspaceBindingView {
    if (!this.bindings.has(projectId))
      this.bindings.set(projectId, {
        bindingId: this.id('binding'),
        projectId,
        trusted: false,
        head: new Map(EXAMPLE_FOLDER),
        folder: new Map(EXAMPLE_FOLDER),
      });
    return this.binding(projectId) as WorkspaceBindingView;
  }

  configure(projectId: string, change: { trusted?: boolean; verifyCommands?: unknown[] }) {
    const b = this.bindings.get(projectId);
    if (!b) throw new Error('this project has no folder');
    if (change.verifyCommands?.length)
      throw new Error('checks run commands on a computer; they need the local server');
    if (change.trusted !== undefined) b.trusted = change.trusted;
    return this.binding(projectId);
  }

  unbind(projectId: string) {
    this.bindings.delete(projectId);
    return null;
  }

  // ── working copies ──────────────────────────────────────────────────────────

  worktree(sessionId: string): WorktreeView | null {
    const c = this.copies.get(sessionId);
    return c
      ? {
          sessionId,
          baseCommit: c.baseTree,
          createdAt: c.createdAt,
          removedAt: null,
          reviewed: c.reviewedTree !== null,
          missing: false,
        }
      : null;
  }

  createWorktree(sessionId: string, projectId: string): WorktreeView {
    const b = this.bindings.get(projectId);
    if (!b) throw new Error('link a folder to the project first');
    if (!b.trusted) throw new Error('trust the repository before making copies');
    if (this.copies.has(sessionId)) throw new Error('this session already has a working copy');
    const files = new Map(b.head);
    this.copies.set(sessionId, {
      bindingId: b.bindingId,
      files,
      baseTree: this.keep(files),
      reviewedTree: null,
      reviewedAt: null,
      createdAt: new Date().toISOString(),
    });
    return this.worktree(sessionId) as WorktreeView;
  }

  removeWorktree(sessionId: string) {
    this.copies.delete(sessionId);
    return null;
  }

  private copy(sessionId: string): Copy {
    const c = this.copies.get(sessionId);
    if (!c) throw new Error('this session has no working copy');
    return c;
  }

  private projectOfCopy(c: Copy): Binding | null {
    return [...this.bindings.values()].find((b) => b.bindingId === c.bindingId) ?? null;
  }

  // ── run snapshots (the server does this around POST /runs) ──────────────────

  runStarting(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    const c = this.copies.get(sessionId);
    return c ? this.keep(c.files) : null;
  }

  runStarted(runId: string, sessionId: string, startTree: string) {
    this.runTrees.set(runId, { sessionId, start: startTree });
  }

  runEnded(runId: string) {
    const entry = this.runTrees.get(runId);
    if (!entry || entry.end) return;
    const c = this.copies.get(entry.sessionId);
    if (c) entry.end = this.keep(c.files);
  }

  runSnapshots(sessionId: string) {
    return [...this.runTrees.entries()]
      .filter(([, v]) => v.sessionId === sessionId)
      .flatMap(([runId, v]) => [
        ...(v.start ? [{ runId, phase: 'start' as const, tree: v.start }] : []),
        ...(v.end ? [{ runId, phase: 'end' as const, tree: v.end }] : []),
      ]);
  }

  // ── comparing ───────────────────────────────────────────────────────────────

  private compare(from: string, to: string, managed: Set<string>): FileChangeView[] {
    const a = this.trees.get(from) ?? new Map<string, string>();
    const b = this.trees.get(to) ?? new Map<string, string>();
    const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
    return paths.flatMap((path) => {
      const before = a.get(path);
      const after = b.get(path);
      if (before === after) return [];
      const lines = diffLines(before ?? '', after ?? '');
      return [
        {
          path,
          status: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
          additions: lines.filter((l) => l.kind === 'added').length,
          deletions: lines.filter((l) => l.kind === 'removed').length,
          binary: false,
          provenance: managed.has(path) ? 'managed_agent' : 'external_observed',
          beforeBlob: before === undefined ? null : contentId(before),
          afterBlob: after === undefined ? null : contentId(after),
        } satisfies FileChangeView,
      ];
    });
  }

  changes(sessionId: string, scope: ChangeScopeQuery): ChangeSetView {
    const c = this.copy(sessionId);
    const now = this.keep(c.files);
    const managed = new Set(
      this.ops
        .filter(
          (o) =>
            o.sessionId === sessionId &&
            o.state === 'applied' &&
            (scope.kind !== 'run' || o.run_id === scope.runId),
        )
        .flatMap((o) => (o.to_path ? [o.path, o.to_path] : [o.path])),
    );
    if (scope.kind === 'run') {
      const run = this.runTrees.get(scope.runId);
      if (!run?.start)
        return { from: null, to: null, unavailable: 'no baseline was recorded', files: [] };
      const to = run.end ?? now;
      return {
        from: run.start,
        to,
        unavailable: null,
        files: this.compare(run.start, to, managed),
      };
    }
    const from = scope.kind === 'review' ? (c.reviewedTree ?? c.baseTree) : c.baseTree;
    return { from, to: now, unavailable: null, files: this.compare(from, now, managed) };
  }

  fileVersions(_sessionId: string, from: string, to: string, path: string) {
    const side = (tree: string): FileSideView => {
      const text = this.trees.get(tree)?.get(path);
      return text === undefined ? { kind: 'absent' } : { kind: 'text', text };
    };
    return { path, before: side(from), after: side(to) };
  }

  folderChanges(projectId: string) {
    const b = this.bindings.get(projectId);
    if (!b) throw new Error('this project has no folder');
    const from = this.keep(b.head);
    const to = this.keep(b.folder);
    return {
      from,
      to: null,
      unavailable: null,
      files: this.compare(from, to, new Set()),
      staged: [],
    };
  }

  folderFileVersions(projectId: string, path: string) {
    const b = this.bindings.get(projectId);
    const side = (files: Files | undefined): FileSideView => {
      const text = files?.get(path);
      return text === undefined ? { kind: 'absent' } : { kind: 'text', text };
    };
    return { path, before: side(b?.head), after: side(b?.folder) };
  }

  markReviewed(sessionId: string) {
    const c = this.copy(sessionId);
    c.reviewedTree = this.keep(c.files);
    c.reviewedAt = new Date().toISOString();
    return null;
  }

  verifications(_sessionId: string): VerificationResultView[] {
    return [];
  }

  verify(): never {
    throw new Error('checks run commands on a computer; they need the local server');
  }

  fileOperations(sessionId: string): FileOperationView[] {
    return this.ops
      .filter((o) => o.sessionId === sessionId)
      .map(({ sessionId: _s, ...o }) => o)
      .reverse();
  }

  // ── the file broker ─────────────────────────────────────────────────────────

  available(runId: string): boolean {
    const sessionId = this.store.getRun(runId)?.sessionId;
    return Boolean(sessionId && this.copies.has(sessionId));
  }

  async execute(
    input: {
      name: 'list_files' | 'read_file' | 'write_file' | 'delete_file' | 'move_file';
      args: Record<string, unknown>;
      runId: string;
      executionId: string;
      toolCallId: string;
    },
    cancellation: ToolCancellation,
  ): Promise<Record<string, unknown>> {
    const sessionId = this.store.getRun(input.runId)?.sessionId;
    const c = sessionId ? this.copies.get(sessionId) : undefined;
    if (!sessionId || !c)
      throw new ToolRefusal('CAPABILITY_DENIED', 'this run has no working copy');
    const reads = this.reads.get(input.runId) ?? new Map<string, string>();
    this.reads.set(input.runId, reads);
    const requireRead = (rel: string) => {
      const current = contentId(c.files.get(rel) ?? '');
      const read = reads.get(rel);
      if (!read) throw new ToolRefusal('REVISION_CONFLICT', `read ${rel} before changing it`);
      if (read !== current)
        throw new ToolRefusal(
          'REVISION_CONFLICT',
          `${rel} changed since you read it; read it again`,
        );
    };
    const record = (kind: string, path: string, toPath: string | null = null) =>
      this.ops.push({
        id: this.id('fileop'),
        sessionId,
        run_id: input.runId,
        kind,
        path,
        to_path: toPath,
        state: 'applied',
        detail: null,
        created_at: new Date().toISOString(),
      });
    if (cancellation.aborted) throw new ToolRefusal('TARGET_TERMINAL', 'the task was cancelled');
    switch (input.name) {
      case 'list_files': {
        const folder =
          typeof input.args.path === 'string' && input.args.path
            ? safeRelative(input.args.path)
            : '';
        const files = [...c.files.entries()]
          .filter(([path]) => !folder || path === folder || path.startsWith(`${folder}/`))
          .map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text).length }));
        return { files, truncated: false };
      }
      case 'read_file': {
        const rel = safeRelative(String(input.args.path));
        const text = c.files.get(rel);
        if (text === undefined) throw new ToolRefusal('TARGET_NOT_FOUND', `${rel} is not a file`);
        reads.set(rel, contentId(text));
        return { path: rel, text, sha256: contentId(text) };
      }
      case 'write_file': {
        const rel = safeRelative(String(input.args.path));
        const text = String(input.args.text ?? '');
        const exists = c.files.has(rel);
        if (exists) requireRead(rel);
        c.files.set(rel, text);
        reads.set(rel, contentId(text));
        record('write', rel);
        return { path: rel, bytes: text.length, created: !exists };
      }
      case 'delete_file': {
        const rel = safeRelative(String(input.args.path));
        if (!c.files.has(rel)) throw new ToolRefusal('TARGET_NOT_FOUND', `${rel} is not a file`);
        requireRead(rel);
        c.files.delete(rel);
        reads.delete(rel);
        record('delete', rel);
        return { path: rel, deleted: true };
      }
      case 'move_file': {
        const from = safeRelative(String(input.args.from));
        const to = safeRelative(String(input.args.to));
        const text = c.files.get(from);
        if (text === undefined) throw new ToolRefusal('TARGET_NOT_FOUND', `${from} is not a file`);
        if (c.files.has(to)) throw new ToolRefusal('REVISION_CONFLICT', `${to} already exists`);
        requireRead(from);
        c.files.delete(from);
        c.files.set(to, text);
        reads.delete(from);
        reads.set(to, contentId(text));
        record('move', from, to);
        return { from, to, moved: true };
      }
    }
  }

  // ── review, decisions, applying (CR-013) ────────────────────────────────────

  listComments(sessionId: string): ReviewCommentView[] {
    return this.comments
      .filter((c) => c.sessionId === sessionId)
      .map(({ sessionId: _s, ...c }) => c);
  }

  addComment(
    sessionId: string,
    input: Omit<ReviewCommentView, 'commentId' | 'state' | 'batchId' | 'createdAt'>,
  ): ReviewCommentView {
    const comment = {
      ...input,
      path: safeRelative(input.path),
      commentId: this.id('comment'),
      state: 'draft' as const,
      batchId: null,
      createdAt: new Date().toISOString(),
    };
    this.comments.push({ ...comment, sessionId });
    return comment;
  }

  setCommentState(
    sessionId: string,
    commentId: string,
    state: ReviewCommentView['state'] | 'deleted',
  ) {
    const index = this.comments.findIndex(
      (c) => c.sessionId === sessionId && c.commentId === commentId,
    );
    const comment = this.comments[index];
    if (!comment) throw new Error('no such comment');
    if (state === 'deleted') {
      if (comment.state !== 'draft') throw new Error('only drafts can be deleted');
      this.comments.splice(index, 1);
    } else comment.state = state;
    return null;
  }

  feedbackText(sessionId: string, commentIds: string[]): string {
    const chosen = this.comments.filter(
      (c) => c.sessionId === sessionId && commentIds.includes(c.commentId) && c.state === 'draft',
    );
    if (chosen.length === 0) throw new Error('choose draft comments');
    return [
      'Review comments on the working copy. Change the files so each one is addressed:',
      ...chosen.map(
        (c, i) =>
          `${i + 1}. ${c.path} lines ${c.startLine}–${c.endLine} (${c.side === 'after' ? 'current' : 'removed'} text):\n   > ${c.quote}\n   ${c.body}`,
      ),
    ].join('\n');
  }

  recordFeedback(sessionId: string, batch: { commentIds: string[]; sent: boolean }) {
    const batchId = this.id('batch');
    if (batch.sent)
      for (const c of this.comments)
        if (
          c.sessionId === sessionId &&
          batch.commentIds.includes(c.commentId) &&
          c.state === 'draft'
        ) {
          c.state = 'submitted';
          c.batchId = batchId;
        }
    return { batchId };
  }

  decisions(sessionId: string): ReviewDecisionView[] {
    const c = this.copies.get(sessionId);
    const latest = c ? this.keep(c.files) : null;
    return this.decisionsList
      .filter((d) => d.sessionId === sessionId)
      .map(({ sessionId: _s, ...d }) => ({ ...d, stale: latest !== null && latest !== d.to }))
      .reverse();
  }

  decide(
    sessionId: string,
    input: { from: string; to: string; decision: ReviewDecisionView['decision']; note: string },
  ) {
    this.copy(sessionId);
    const decisionId = this.id('decision');
    this.decisionsList.push({
      ...input,
      decisionId,
      sessionId,
      createdAt: new Date().toISOString(),
    });
    return { decisionId };
  }

  private approved(sessionId: string, decisionId: string) {
    const d = this.decisionsList.find(
      (x) => x.sessionId === sessionId && x.decisionId === decisionId,
    );
    if (!d) throw new Error('no such decision');
    if (d.decision !== 'approved') throw new Error('only approved changes are applied');
    return d;
  }

  integrationPlan(sessionId: string, decisionId: string): IntegrationPlanFile[] {
    const c = this.copy(sessionId);
    const d = this.approved(sessionId, decisionId);
    const folder = this.projectOfCopy(c)?.folder ?? new Map<string, string>();
    const base = this.trees.get(c.baseTree) ?? new Map<string, string>();
    const target = this.trees.get(d.to) ?? new Map<string, string>();
    return this.compare(c.baseTree, d.to, new Set()).map((f) => {
      const action = f.status === 'deleted' ? ('delete' as const) : ('write' as const);
      const now = folder.get(f.path);
      if (now === target.get(f.path))
        return { path: f.path, action, outcome: 'skip' as const, reason: 'already like this' };
      if (now === base.get(f.path))
        return { path: f.path, action, outcome: 'apply' as const, reason: null };
      return {
        path: f.path,
        action,
        outcome: 'conflict' as const,
        reason: 'changed in the folder since the copy was made',
      };
    });
  }

  integrate(sessionId: string, decisionId: string): IntegrationResultView {
    const c = this.copy(sessionId);
    const d = this.approved(sessionId, decisionId);
    const binding = this.projectOfCopy(c);
    if (!binding) throw new Error('this project has no folder');
    const target = this.trees.get(d.to) ?? new Map<string, string>();
    const files = this.integrationPlan(sessionId, decisionId).map((f) => {
      if (f.outcome !== 'apply')
        return {
          path: f.path,
          action: f.action,
          outcome: f.outcome === 'skip' ? 'skipped' : 'conflict',
          detail: f.reason,
        };
      const text = target.get(f.path);
      if (text === undefined) binding.folder.delete(f.path);
      else binding.folder.set(f.path, text);
      return { path: f.path, action: f.action, outcome: 'applied', detail: null };
    });
    const outcomes = files.map((f) => f.outcome);
    const result: IntegrationResultView = {
      integrationId: this.id('integration'),
      decisionId,
      state: outcomes.every((o) => o === 'applied' || o === 'skipped')
        ? 'applied'
        : outcomes.includes('applied')
          ? 'partial'
          : 'conflict',
      createdAt: new Date().toISOString(),
      files,
    };
    this.integrationsList.push({ ...result, sessionId, from: c.baseTree, to: d.to });
    return result;
  }

  integrations(sessionId: string): IntegrationResultView[] {
    return this.integrationsList
      .filter((i) => i.sessionId === sessionId)
      .map(({ sessionId: _s, from: _f, to: _t, ...i }) => i)
      .reverse();
  }

  revert(sessionId: string, integrationId: string): IntegrationResultView {
    const entry = this.integrationsList.find(
      (i) => i.sessionId === sessionId && i.integrationId === integrationId,
    );
    if (!entry) throw new Error('no such integration');
    const binding = this.projectOfCopy(this.copy(sessionId));
    const base = this.trees.get(entry.from) ?? new Map<string, string>();
    const target = this.trees.get(entry.to) ?? new Map<string, string>();
    for (const file of entry.files) {
      if (file.outcome !== 'applied' || !binding) continue;
      if (binding.folder.get(file.path) !== target.get(file.path)) {
        file.outcome = 'revert_conflict';
        file.detail = 'changed in the folder after it was applied';
        continue;
      }
      const before = base.get(file.path);
      if (before === undefined) binding.folder.delete(file.path);
      else binding.folder.set(file.path, before);
      file.outcome = 'reverted';
    }
    if (entry.files.some((f) => f.outcome === 'reverted'))
      entry.state = entry.files.every(
        (f) => f.outcome !== 'applied' && f.outcome !== 'revert_conflict',
      )
        ? 'reverted'
        : 'partial';
    const { sessionId: _s, from: _f, to: _t, ...view } = entry;
    return view;
  }

  /** What needs a person in these sessions, by the same rules as the server (CR-013). */
  inboxFacts(sessions: { sessionId: string; title: string }[]): InboxItemView[] {
    const items: InboxItemView[] = [];
    for (const s of sessions) {
      const last = this.integrationsList.filter((i) => i.sessionId === s.sessionId).at(-1);
      if (last && ['partial', 'conflict', 'failed'].includes(last.state))
        items.push({
          kind: 'integration',
          sessionId: s.sessionId,
          sessionTitle: s.title,
          runId: null,
          detail: last.state,
        });
      const c = this.copies.get(s.sessionId);
      if (!c) continue;
      const since = this.ops.filter(
        (o) => o.sessionId === s.sessionId && (!c.reviewedAt || o.created_at > c.reviewedAt),
      ).length;
      if (since > 0)
        items.push({
          kind: 'unreviewed',
          sessionId: s.sessionId,
          sessionTitle: s.title,
          runId: null,
          detail: String(since),
        });
    }
    return items;
  }
}
