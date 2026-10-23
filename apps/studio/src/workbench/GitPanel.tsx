import { ApiError, type FileBrowseScope } from '@corral/client';
import {
  canonicalJson,
  type GitAdvancedCommand,
  type GitAdvancedOperation,
  type GitDiff,
  type GitDiffRequest,
  type GitOperation,
  type GitSequenceState,
  type GitStatus,
  type GitStatusEntry,
  type GitWriteCommand,
  type GitWriteResult,
  type WorkspaceTarget,
} from '@corral/contracts';
import { Button, Input, Select, Textarea } from '@corral/react/design-kit';
import { Minus, Plus } from '@corral/react/icons';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { FileDiff } from '../pages/ReviewPage.tsx';
import { useServices } from '../services.tsx';
import { documentStore } from './documents/store.ts';
import { GitConflicts } from './GitConflicts.tsx';
import { GitHunks } from './GitHunks.tsx';
import { GitSequence } from './GitSequence.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

type Side = GitDiffRequest['side'];
const sides: Side[] = ['staged', 'unstaged', 'untracked'];
const changed = (value: string) => value !== '.' && value.trim() !== '';
const belongs = (entry: GitStatusEntry, side: Side) =>
  side === 'untracked'
    ? entry.kind === 'untracked'
    : entry.kind !== 'untracked' &&
      entry.kind !== 'unmerged' &&
      changed(side === 'staged' ? entry.indexStatus : entry.worktreeStatus);

type WithoutId<T> = T extends unknown ? Omit<T, 'operationId'> : never;
type GitInput = WithoutId<GitWriteCommand>;
type AdvancedInput = WithoutId<GitAdvancedCommand>;
type Pending = {
  operationId: string;
  kind: GitWriteCommand['kind'] | GitAdvancedCommand['kind'];
  advanced?: true;
  target?: WorkspaceTarget;
};
const pendingKey = (sessionId: string) => `corral:git-operation:v1:${sessionId}`;
function readPending(sessionId: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey(sessionId)) ?? 'null');
    return value && typeof value.operationId === 'string' ? value : null;
  } catch {
    return null;
  }
}
function writePending(sessionId: string, value: Pending | null) {
  try {
    if (value) sessionStorage.setItem(pendingKey(sessionId), JSON.stringify(value));
    else sessionStorage.removeItem(pendingKey(sessionId));
  } catch {
    /* The receipt is still on the host; only the reopen shortcut is lost. */
  }
}
const FAILURE_KEYS = {
  locked: 'writeLocked',
  hook_failed: 'hookFailed',
  signing_unavailable: 'signingUnavailable',
  author_missing: 'authorMissing',
  branch_in_use: 'branchInUse',
  dirty_tree: 'dirtyTree',
  non_fast_forward: 'nonFastForward',
  remote_unavailable: 'remoteUnavailable',
} as const;

/**
 * User Git observations are separate from Corral's internal snapshot comparisons. In a trusted
 * session copy the same view stages, unstages and commits with a receipt (CR-046 P13).
 */
export function GitPanel({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const t = useTranslations('Git');
  const { workspaces, workspaceId, mode } = useServices();
  const [source, setSource] = useState<'session' | 'project'>('session');
  const [revision, setRevision] = useState(0);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState<Pending | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<{ key: string; detail?: string } | null>(null);
  const [message, setMessage] = useState('');
  const [runHooks, setRunHooks] = useState(true);
  const [author, setAuthor] = useState<{ name: string; email: string } | null>(null);
  const context = useRef({ workspaces, sessionId, workspaceId });
  context.current = { workspaces, sessionId, workspaceId };
  useEffect(() => {
    let live = true;
    if (!workspaces?.binding) return;
    void workspaces.binding(projectId).then(
      (binding) => live && setTrusted(Boolean(binding?.trusted)),
      () => live && setTrusted(false),
    );
    return () => {
      live = false;
    };
  }, [workspaces, projectId]);
  const settle = useCallback(
    (receipt: GitOperation | GitAdvancedOperation, pending: Pending) => {
      if (context.current.workspaces !== workspaces || context.current.sessionId !== sessionId)
        return;
      if (
        receipt.operationId !== pending.operationId ||
        receipt.target.sessionId !== sessionId ||
        receipt.target.hostId !== context.current.workspaceId ||
        (pending.target && canonicalJson(receipt.target) !== canonicalJson(pending.target))
      ) {
        setUnconfirmed(pending);
        setFailure({ key: 'stateChanged' });
        return;
      }
      if (receipt.state === 'running' || receipt.state === 'uncertain') {
        setUnconfirmed(pending);
        return;
      }
      writePending(sessionId, null);
      setUnconfirmed(null);
      if (pending.advanced) {
        const result = (receipt as GitAdvancedOperation).result;
        setFailure(
          result.kind === 'conflicted'
            ? { key: 'sequenceConflicted' }
            : result.kind === 'error'
              ? {
                  key: result.error?.code === 'REVISION_CONFLICT' ? 'stateChanged' : 'writeFailed',
                  detail: result.error?.message,
                }
              : receipt.state === 'cancelled'
                ? { key: 'writeCancelled' }
                : null,
        );
        if (workspaces && (result.kind === 'applied' || result.kind === 'conflicted')) {
          const owner = documentStore(workspaces);
          void Promise.allSettled(
            Object.values(owner.getState().documents)
              .filter(
                (entry) =>
                  canonicalJson(entry.target) === canonicalJson(receipt.target) &&
                  !entry.dirty &&
                  !entry.saving &&
                  !entry.pendingSave &&
                  !entry.conflict,
              )
              .map((entry) => owner.refresh(entry.key)),
          );
          window.dispatchEvent(new Event(WORKSPACE_CHANGED));
        }
        setRevision((value) => value + 1);
        return;
      }
      const result = receipt.result as GitWriteResult | null;
      if (receipt.state === 'succeeded') {
        setFailure(null);
        if (pending.kind === 'commit') setMessage('');
        if (pending.kind === 'branch') setBranchName('');
      } else if (result?.kind === 'error') {
        if (result.reason === 'author_missing')
          setAuthor((value) => value ?? { name: '', email: '' });
        setFailure(
          receipt.state === 'cancelled'
            ? { key: 'writeCancelled' }
            : result.reason
              ? { key: FAILURE_KEYS[result.reason], detail: result.message }
              : result.code === 'REVISION_CONFLICT'
                ? { key: 'stateChanged' }
                : { key: 'writeFailed', detail: result.message },
        );
      }
      setRevision((value) => value + 1);
    },
    [sessionId, workspaces],
  );
  const check = useCallback(
    async (pending: Pending) => {
      if (!workspaces?.gitOperation) return;
      try {
        settle(
          await (pending.advanced
            ? workspaces.gitAdvancedOperation(sessionId, pending.operationId)
            : workspaces.gitOperation(sessionId, pending.operationId)),
          pending,
        );
      } catch {
        if (context.current.workspaces === workspaces && context.current.sessionId === sessionId)
          setUnconfirmed(pending);
      }
    },
    [workspaces, sessionId, settle],
  );
  const recoverAdvanced = async (pending: Pending, action: 'reconcile' | 'cancel') => {
    if (!pending.advanced || !pending.target || !workspaces || busy) return;
    setBusy(pending);
    try {
      const value =
        action === 'cancel'
          ? await workspaces.cancelGitAdvanced(sessionId, pending.operationId)
          : await workspaces.reconcileGitAdvanced(sessionId, {
              target: pending.target,
              operationId: pending.operationId,
            });
      settle(value, pending);
    } catch (error) {
      if (context.current.workspaces === workspaces && context.current.sessionId === sessionId) {
        setUnconfirmed(pending);
        setFailure({
          key: 'writeFailed',
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    } finally {
      if (context.current.workspaces === workspaces && context.current.sessionId === sessionId)
        setBusy(null);
    }
  };
  // A change whose answer never arrived is read back by its own ID, never sent again.
  useEffect(() => {
    const pending = readPending(sessionId);
    setUnconfirmed(null);
    if (pending) void check(pending);
  }, [sessionId, check]);
  const query = useMemo(
    () => ({
      client: workspaces,
      hostId: workspaceId,
      projectId,
      revision,
      mode,
      scope: { kind: source, id: source === 'session' ? sessionId : projectId } as FileBrowseScope,
    }),
    [workspaces, workspaceId, projectId, revision, mode, source, sessionId],
  );
  const [loaded, setLoaded] = useState<{
    query: typeof query;
    data: GitStatus | null;
    error: boolean;
    /** The session has no working copy: nothing to read, which is not an error. */
    noCopy?: boolean;
  } | null>(null);
  const [selection, setSelection] = useState<{
    query: typeof query;
    side: Side;
    path: string;
  } | null>(null);
  const result = loaded?.query === query ? loaded : null;
  const status = result?.data ?? null;
  const currentStatus = useRef(status);
  currentStatus.current = status;
  const selected = selection?.query === query ? selection : null;
  const [sequenceResult, setSequenceResult] = useState<{
    status: GitStatus;
    value: GitSequenceState;
  } | null>(null);
  const sequence = sequenceResult?.status === status ? sequenceResult.value : null;
  useEffect(() => {
    let live = true;
    if (status?.target.kind !== 'session' || typeof workspaces?.gitSequence !== 'function') return;
    const { kind: _kind, ...target } = status.target;
    void workspaces.gitSequence(sessionId).then(
      (value) => {
        if (
          live &&
          canonicalJson(value.target) === canonicalJson(target) &&
          value.head === status.head.oid &&
          value.indexHash === status.indexHash
        )
          setSequenceResult({ status, value });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [status, workspaces, sessionId]);
  const id = useId();
  useEffect(() => {
    let live = true;
    const client = query.client;
    if (!client || query.mode !== 'server' || !query.hostId) {
      setLoaded({ query, data: null, error: true });
      return;
    }
    const readStatus = () =>
      void client.gitStatus(query.scope).then(
        (data) => {
          if (!live) return;
          const target = data.target;
          const matches =
            target.kind === query.scope.kind &&
            target.hostId === query.hostId &&
            target.projectId === query.projectId &&
            (target.kind === 'project'
              ? target.projectId === query.scope.id
              : target.sessionId === query.scope.id);
          setLoaded({ query, data: matches ? data : null, error: !matches });
        },
        () => {
          if (live) setLoaded({ query, data: null, error: true });
        },
      );
    const copy =
      query.scope.kind === 'session'
        ? client.worktree(query.scope.id).then(
            (view) => Boolean(view && !view.missing),
            () => true,
          )
        : Promise.resolve(true);
    void copy.then((present) => {
      if (!live) return;
      if (!present) {
        setLoaded({ query, data: null, error: false, noCopy: true });
        return;
      }
      readStatus();
    });
    return () => {
      live = false;
    };
  }, [query]);
  const loadKey =
    status && selected
      ? canonicalJson([
          status.target,
          selected.side,
          selected.path,
          status.head.oid,
          status.indexHash,
          revision,
        ])
      : '';
  const loadDiff = async () => {
    if (!status || !selected || !query.client) throw new Error(t('unavailable'));
    const request: GitDiffRequest = {
      target: status.target,
      side: selected.side,
      path: selected.path,
      head: status.head.oid,
      indexHash: status.indexHash,
    };
    let response: GitDiff;
    try {
      response = await query.client.gitDiff(query.scope, request);
    } catch (error) {
      throw new Error(
        t(error instanceof ApiError && error.status === 409 ? 'stateChanged' : 'unavailable'),
      );
    }
    if (
      canonicalJson(response.target) !== canonicalJson(request.target) ||
      response.side !== request.side ||
      response.path !== request.path ||
      response.head !== request.head ||
      response.indexHash !== request.indexHash
    )
      throw new Error(t('stateChanged'));
    if (response.kind === 'unsupported') throw new Error(t('unsupported'));
    return { before: response.before, after: response.after };
  };
  const conflicts = status?.entries.filter((entry) => entry.kind === 'unmerged') ?? [];
  const writable =
    trusted &&
    source === 'session' &&
    status?.target.kind === 'session' &&
    Boolean(workspaces?.gitChange);
  const staged = status?.entries.filter((entry) => belongs(entry, 'staged')) ?? [];
  const [branchName, setBranchName] = useState('');
  // The pane re-reads Git after each change; the section stays as the person left it.
  const [branchOpen, setBranchOpen] = useState(false);
  const remote =
    status?.head.upstream?.name.split('/')[0] ??
    (status?.remotes?.includes('origin') ? 'origin' : status?.remotes?.[0]);
  const upstreamBranch = status?.head.upstream?.name.split('/').slice(1).join('/');
  const others = status?.branches?.filter((branch) => branch !== status.head.branch) ?? [];
  /** Unsaved documents of this copy stay unsaved; switching would read the other branch. */
  const unsaved = () =>
    workspaces
      ? Object.values(documentStore(workspaces).getState().documents).some(
          (entry) => entry.target.sessionId === sessionId && entry.dirty,
        )
      : false;
  const execute = async (input: GitInput | AdvancedInput, advanced = false) => {
    if (
      !status ||
      currentStatus.current !== status ||
      status.target.kind !== 'session' ||
      !workspaces ||
      !writable ||
      busy ||
      unconfirmed
    )
      return;
    const { kind: _kind, ...target } = status.target;
    if (
      canonicalJson(input.target) !== canonicalJson(target) ||
      input.expect.head !== status.head.oid ||
      input.expect.indexHash !== status.indexHash
    ) {
      setFailure({ key: 'stateChanged' });
      return;
    }
    if (
      advanced &&
      !['stage_hunks', 'unstage_hunks'].includes(input.kind) &&
      Object.values(documentStore(workspaces).getState().documents).some(
        (entry) =>
          canonicalJson(entry.target) === canonicalJson(target) &&
          (entry.dirty || entry.saving || entry.pendingSave || entry.conflict),
      )
    ) {
      setFailure({ key: 'unsavedDocuments' });
      return;
    }
    const pending: Pending = {
      operationId: `git_${crypto.randomUUID().replaceAll('-', '')}`,
      kind: input.kind,
      ...(advanced ? { advanced: true, target } : {}),
    };
    const command = { ...input, operationId: pending.operationId };
    writePending(sessionId, pending);
    setBusy(pending);
    setFailure(null);
    try {
      const receipt = advanced
        ? await (command.kind === 'stage_hunks' || command.kind === 'unstage_hunks'
            ? workspaces.changeGitHunks(
                sessionId,
                command as Extract<GitAdvancedCommand, { kind: 'stage_hunks' | 'unstage_hunks' }>,
              )
            : workspaces.changeGitSequence(
                sessionId,
                command as Exclude<GitAdvancedCommand, { kind: 'stage_hunks' | 'unstage_hunks' }>,
              ))
        : await workspaces.gitChange(sessionId, command as GitWriteCommand);
      settle(receipt, pending);
    } catch (error) {
      if (context.current.workspaces !== workspaces || context.current.sessionId !== sessionId)
        return;
      if (error instanceof ApiError && error.status < 500 && error.status !== 0) {
        writePending(sessionId, null);
        setFailure(
          error.status === 409
            ? { key: 'stateChanged' }
            : { key: 'writeFailed', detail: error.message },
        );
        setRevision((value) => value + 1);
      } else setUnconfirmed(pending);
    } finally {
      if (context.current.workspaces === workspaces && context.current.sessionId === sessionId)
        setBusy(null);
    }
  };
  const change = async (
    body:
      | { kind: 'stage' | 'unstage'; paths: string[] }
      | { kind: 'commit'; message: string; staged: string[]; runHooks: boolean }
      | { kind: 'branch'; name: string }
      | { kind: 'switch'; branch: string }
      | { kind: 'fetch'; remote: string }
      | { kind: 'pull'; remote: string; branch: string }
      | { kind: 'push'; remote: string; branch: string; runHooks: boolean },
  ) => {
    if (body.kind === 'switch' && unsaved()) {
      setFailure({ key: 'unsavedDocuments' });
      return;
    }
    if (status?.target.kind !== 'session' || !workspaces?.gitChange || busy || unconfirmed) return;
    const { kind: _kind, ...target } = status.target;
    const command = {
      ...body,
      target,
      expect: { head: status.head.oid, indexHash: status.indexHash },
      ...(body.kind === 'commit' && author?.name && author.email ? { author } : {}),
    } as GitInput;
    await execute(command);
  };
  const sequenceControls =
    writable && workspaces && sequence && status ? (
      <GitSequence
        sessionId={sessionId}
        status={status}
        state={sequence}
        owner={documentStore(workspaces)}
        disabled={Boolean(busy || unconfirmed)}
        runHooks={runHooks}
        onRunHooksChange={setRunHooks}
        author={author?.name && author.email ? author : undefined}
        onCommand={(command) => execute(command, true)}
      />
    ) : null;
  return (
    <section aria-label={t('title')} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label={t('source')}
          size="sm"
          value={source}
          onValueChange={(value) => setSource(value as 'session' | 'project')}
          options={[
            { value: 'session', label: t('sessionSource') },
            { value: 'project', label: t('projectSource') },
          ]}
        />
        <Button
          size="compact"
          variant="tertiary"
          disabled={!result}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t('refresh')}
        </Button>
      </div>
      {!result ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('loading')}
        </p>
      ) : result.noCopy ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('noSessionCopy')}
        </p>
      ) : result.error ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {t('unavailable')}
        </p>
      ) : null}
      {status ? (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span>
              {t('branch')}:{' '}
              <span className="break-all font-mono">{status.head.branch ?? '—'}</span>
            </span>
            <span title={status.head.oid ?? undefined}>
              {t('head')}: <code>{status.head.oid?.slice(0, 12) ?? '—'}</code>
            </span>
            {status.head.detached ? <span>{t('detached')}</span> : null}
            {status.head.unborn ? <span>{t('unborn')}</span> : null}
            {status.head.shallow ? <span>{t('shallow')}</span> : null}
            <span>
              {t('upstream')}:{' '}
              <span className="break-all font-mono">
                {status.head.upstream?.name ?? t('noUpstream')}
              </span>
            </span>
            {status.head.upstream &&
            status.head.upstream.ahead !== null &&
            status.head.upstream.behind !== null ? (
              <span>
                {t('aheadBehind', {
                  ahead: status.head.upstream.ahead,
                  behind: status.head.upstream.behind,
                })}
              </span>
            ) : null}
          </div>
          {writable ? (
            <details
              className="text-xs"
              open={branchOpen}
              onToggle={(event) => setBranchOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer select-none py-1 font-medium">
                {t('branchActions')}
              </summary>
              <div className="flex flex-col gap-2 pt-1">
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (branchName.trim()) void change({ kind: 'branch', name: branchName.trim() });
                  }}
                >
                  <Input
                    aria-label={t('newBranch')}
                    placeholder={t('newBranch')}
                    value={branchName}
                    onChange={(event) => setBranchName(event.target.value)}
                    className="w-48"
                  />
                  <Button
                    type="submit"
                    size="compact"
                    variant="tertiary"
                    disabled={!branchName.trim() || Boolean(busy || unconfirmed)}
                  >
                    {t('createBranch')}
                  </Button>
                </form>
                {others.length ? (
                  <ul className="flex flex-wrap gap-1">
                    {others.slice(0, 20).map((branch) => (
                      <li key={branch}>
                        <Button
                          size="compact"
                          variant="ghost"
                          aria-label={t('switchTo', { branch })}
                          title={t('switchTo', { branch })}
                          disabled={Boolean(busy || unconfirmed)}
                          onClick={() => void change({ kind: 'switch', branch })}
                        >
                          <span className="font-mono">{branch}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {remote ? (
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="compact"
                      variant="tertiary"
                      disabled={Boolean(busy || unconfirmed)}
                      onClick={() => void change({ kind: 'fetch', remote })}
                    >
                      {t('fetch')}
                    </Button>
                    <Button
                      size="compact"
                      variant="tertiary"
                      disabled={!status.head.branch || Boolean(busy || unconfirmed)}
                      onClick={() =>
                        void change({
                          kind: 'pull',
                          remote,
                          branch: upstreamBranch || (status.head.branch ?? ''),
                        })
                      }
                    >
                      {t('pull')}
                    </Button>
                    <Button
                      size="compact"
                      variant="tertiary"
                      disabled={!status.head.branch || Boolean(busy || unconfirmed)}
                      onClick={() =>
                        status.head.branch &&
                        void change({ kind: 'push', remote, branch: status.head.branch, runHooks })
                      }
                    >
                      {t('push')}
                    </Button>
                  </div>
                ) : null}
                {!sequence?.sequence ? sequenceControls : null}
              </div>
            </details>
          ) : null}
          {sequence?.sequence ? sequenceControls : null}
          {status.filtersDisabled ? (
            <p className="text-xs text-muted-foreground">{t('rawContent')}</p>
          ) : null}
          {status.truncated ? (
            <p role="status" className="text-xs text-warning">
              {t('truncated')}
            </p>
          ) : null}
          {unconfirmed ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-warning">
              <span>{t('unconfirmed')}</span>
              <Button
                size="compact"
                variant="tertiary"
                disabled={Boolean(busy)}
                onClick={() => void check(unconfirmed)}
              >
                {t('checkAgain')}
              </Button>
              {unconfirmed.advanced ? (
                <>
                  <Button
                    size="compact"
                    variant="tertiary"
                    disabled={Boolean(busy)}
                    onClick={() => void recoverAdvanced(unconfirmed, 'reconcile')}
                  >
                    {t('reconcile')}
                  </Button>
                  <Button
                    size="compact"
                    variant="ghost"
                    disabled={Boolean(busy)}
                    onClick={() => void recoverAdvanced(unconfirmed, 'cancel')}
                  >
                    {t('cancel')}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          {busy?.advanced && !unconfirmed ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-xs">
              <span>{t('advancedRunning')}</span>
              <Button
                size="compact"
                variant="tertiary"
                onClick={() =>
                  void workspaces
                    ?.cancelGitAdvanced(sessionId, busy.operationId)
                    .then((value) => settle(value, busy))
                    .catch(() => setUnconfirmed(busy))
                }
              >
                {t('cancel')}
              </Button>
            </div>
          ) : null}
          {failure ? (
            <div role="alert" className="flex flex-col gap-1 text-xs text-danger">
              <span>{t(failure.key)}</span>
              {failure.detail && failure.key !== 'stateChanged' ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">
                  {failure.detail}
                </pre>
              ) : null}
            </div>
          ) : null}
          {writable && staged.length && !sequence?.sequence ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void change({
                  kind: 'commit',
                  message,
                  staged: staged.map((entry) => entry.path),
                  runHooks,
                });
              }}
            >
              <Textarea
                id="git-commit-message"
                aria-label={t('commitMessage')}
                placeholder={t('commitMessage')}
                rows={2}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
              {author ? (
                <div className="flex flex-wrap gap-2">
                  <Input
                    aria-label={t('authorName')}
                    placeholder={t('authorName')}
                    value={author.name}
                    onChange={(event) => setAuthor({ ...author, name: event.target.value })}
                  />
                  <Input
                    type="email"
                    aria-label={t('authorEmail')}
                    placeholder={t('authorEmail')}
                    value={author.email}
                    onChange={(event) => setAuthor({ ...author, email: event.target.value })}
                  />
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  size="compact"
                  disabled={!message.trim() || Boolean(busy) || Boolean(unconfirmed)}
                >
                  {busy?.kind === 'commit'
                    ? t('committing')
                    : t('commit', { count: staged.length })}
                </Button>
                {busy?.kind === 'commit' ? (
                  <Button
                    type="button"
                    size="compact"
                    variant="tertiary"
                    onClick={() =>
                      void workspaces?.cancelGitOperation?.(sessionId, busy.operationId)
                    }
                  >
                    {t('cancel')}
                  </Button>
                ) : null}
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={runHooks}
                    onChange={(event) => setRunHooks(event.target.checked)}
                  />
                  {t('runHooks')}
                </label>
              </div>
            </form>
          ) : null}
          {!status.entries.length ? (
            <p className="text-xs text-muted-foreground">{t('noChanges')}</p>
          ) : null}
          {sides.map((side) => {
            const entries = status.entries.filter((entry) => belongs(entry, side));
            return (
              <section key={side} aria-labelledby={`${id}-${side}`} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 id={`${id}-${side}`} className="text-xs font-semibold">
                    {t(side)} · {entries.length}
                  </h3>
                  {writable && entries.length > 1 ? (
                    <Button
                      size="compact"
                      variant="ghost"
                      disabled={Boolean(busy || unconfirmed)}
                      onClick={() =>
                        void change({
                          kind: side === 'staged' ? 'unstage' : 'stage',
                          paths: entries.map((entry) => entry.path),
                        })
                      }
                    >
                      {t(side === 'staged' ? 'unstageAll' : 'stageAll')}
                    </Button>
                  ) : null}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {entries.map((entry) => (
                    <li key={entry.path} className="flex items-start gap-1">
                      <Button
                        variant={
                          selected?.side === side && selected.path === entry.path
                            ? 'secondary'
                            : 'ghost'
                        }
                        size="compact"
                        data-git-side={side}
                        data-path={entry.path}
                        aria-pressed={selected?.side === side && selected.path === entry.path}
                        onClick={() => setSelection({ query, side, path: entry.path })}
                        className="h-auto min-w-0 flex-1 flex-wrap justify-start gap-x-2 whitespace-normal py-1.5 text-left"
                      >
                        <span className="whitespace-pre-wrap break-all font-mono">
                          {entry.originalPath ? `${entry.originalPath} → ` : ''}
                          {entry.path}
                        </span>
                        <span className="text-muted-foreground">
                          {side === 'staged' ? entry.indexStatus : entry.worktreeStatus}
                          {entry.submodule ? ` · ${t('submodule')}` : ''}
                        </span>
                      </Button>
                      {writable ? (
                        <Button
                          size="icon-compact"
                          variant="ghost"
                          aria-label={t(side === 'staged' ? 'unstage' : 'stage', {
                            path: entry.path,
                          })}
                          title={t(side === 'staged' ? 'unstage' : 'stage', { path: entry.path })}
                          disabled={Boolean(busy || unconfirmed)}
                          onClick={() =>
                            void change({
                              kind: side === 'staged' ? 'unstage' : 'stage',
                              paths: [entry.path],
                            })
                          }
                        >
                          {side === 'staged' ? <Minus /> : <Plus />}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {conflicts.length ? (
            <section aria-labelledby={`${id}-conflicts`} className="flex flex-col gap-1">
              <h3 id={`${id}-conflicts`} className="text-xs font-semibold">
                {t('conflicts')} · {conflicts.length}
              </h3>
              {sequence && typeof workspaces?.gitConflict === 'function' ? (
                <GitConflicts
                  api={workspaces}
                  owner={documentStore(workspaces)}
                  state={sequence}
                  writable={Boolean(writable)}
                  disabled={Boolean(busy || unconfirmed)}
                  onStage={(command) => execute(command)}
                />
              ) : (
                <>
                  <p className="text-xs text-warning">{t('conflictUnavailable')}</p>
                  <ul>
                    {conflicts.map((entry) => (
                      <li
                        key={entry.path}
                        className="whitespace-pre-wrap break-all font-mono text-xs"
                      >
                        {entry.path}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          ) : null}
          {selected ? (
            <section
              aria-label={t(`comparison.${selected.side}`)}
              className="flex min-w-0 flex-col gap-2"
            >
              <h3 className="text-xs font-semibold">{t(`comparison.${selected.side}`)}</h3>
              {writable &&
              status.target.kind === 'session' &&
              selected.side !== 'untracked' &&
              typeof workspaces?.gitHunks === 'function' ? (
                <GitHunks
                  key={loadKey}
                  sessionId={sessionId}
                  request={{
                    target: status.target,
                    side: selected.side,
                    path: selected.path,
                    head: status.head.oid,
                    indexHash: status.indexHash,
                  }}
                  disabled={Boolean(busy || unconfirmed)}
                  onCommand={(command) => execute(command, true)}
                />
              ) : null}
              <FileDiff key={loadKey} path={selected.path} loadKey={loadKey} load={loadDiff} />
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
