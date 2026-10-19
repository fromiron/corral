import type {
  InboxItemView,
  VerifyCommand,
  WorkspaceBindingView,
  WorktreeView,
} from '@corral/client';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { desktop } from '../desktop.tsx';
import { useServices } from '../services.tsx';
import { CheckpointPanel } from '../workbench/CheckpointPanel.tsx';

// Work folders and working copies in Studio (CR-012), on the local server or the demo's
// in-memory example folder.

/** Fired when a session's working copy is made or removed. */
export const WORKSPACE_CHANGED = 'corral:workspace-changed';

/** "Name = command args" per line; quotes keep spaces inside one argument. */
export function parseChecks(text: string): VerifyCommand[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line, index) => {
      const at = line.indexOf('=');
      if (at <= 0) return [];
      const name = line.slice(0, at).trim();
      const argv = [...line.slice(at + 1).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
        (m) => m[1] ?? m[2] ?? m[3] ?? '',
      );
      return name && argv.length > 0
        ? [{ id: `check_${index + 1}`, name: name.slice(0, 80), argv, timeoutMs: 10 * 60_000 }]
        : [];
    });
}

const formatChecks = (checks: VerifyCommand[]) =>
  checks
    .map((c) => `${c.name} = ${c.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`)
    .join('\n');

export function useBinding(projectId: string | null) {
  const { workspaces } = useServices();
  const [binding, setBinding] = useState<WorkspaceBindingView | null | undefined>(undefined);
  const reload = useCallback(async () => {
    if (!workspaces || !projectId) return setBinding(null);
    try {
      setBinding(await workspaces.binding(projectId));
    } catch {
      setBinding(null);
    }
  }, [workspaces, projectId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { binding, reload };
}

/** The project's linked folder, its trust and checks (project page). */
export function WorkFolderSection({ projectId }: { projectId: string }) {
  const t = useTranslations('Files');
  const { workspaces, mode } = useServices();
  const { binding, reload } = useBinding(projectId);
  const [path, setPath] = useState(mode === 'browser' ? 'demo://example-repo' : '');
  const [checks, setChecks] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!workspaces || binding === undefined) return null;
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await reload();
      window.dispatchEvent(new Event(WORKSPACE_CHANGED));
    } catch (failure) {
      setError(
        t('failed', { message: failure instanceof Error ? failure.message : String(failure) }),
      );
    }
  };
  const link = (event: FormEvent) => {
    event.preventDefault();
    void act(() => workspaces.bind(projectId, path.trim()));
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">{t('folderIntro')}</p>
      {mode === 'browser' ? <p className="text-sm text-warning">{t('demoFolder')}</p> : null}
      {!binding ? (
        <form onSubmit={link} className="settings-row">
          <div>
            <h3>{t('pathLabel')}</h3>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              spellCheck={false}
              aria-label={t('pathLabel')}
              className="settings-field font-mono sm:w-80"
            />
            <div className="flex gap-2">
              {desktop ? (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() =>
                    void act(async () => {
                      const folder = await desktop?.pickFolder();
                      if (folder) setPath(folder);
                    })
                  }
                >
                  {t('chooseFolder')}
                </Button>
              ) : null}
              <Button variant="outline" size="sm" type="submit" disabled={!path.trim()}>
                {t('link')}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <>
          <section className="settings-row">
            <div>
              <h3>{t('pathLabel')}</h3>
              <p title={binding.path}>{binding.path}</p>
              {binding.missing ? (
                <p role="alert" className="text-danger">
                  {t('folderMissing', { path: binding.path })}
                </p>
              ) : null}
              {binding.isGit && binding.status ? (
                <p>
                  {t('gitStatus', {
                    branch: binding.status.branch ?? '—',
                    head: binding.status.head ?? '—',
                    changed: binding.status.changed,
                  })}
                </p>
              ) : null}
              {!binding.isGit ? <p className="text-warning">{t('notGit')}</p> : null}
            </div>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void act(() => workspaces.unbind(projectId))}
            >
              {t('unlink')}
            </Button>
          </section>
          {binding.isGit ? (
            <label className="settings-row">
              <span>
                <span className="text-sm font-medium">{t('trust')}</span>
                <span className="mt-1 block text-xs text-muted">{t('trustHint')}</span>
              </span>
              <input
                type="checkbox"
                aria-label={t('trust')}
                checked={binding.trusted}
                onChange={(e) =>
                  void act(() => workspaces.configure(projectId, { trusted: e.target.checked }))
                }
              />
            </label>
          ) : null}
          {binding.trusted ? (
            <section className="settings-surface flex flex-col gap-3">
              <div>
                <h3 className="text-sm font-medium">{t('checksHeading')}</h3>
                <p className="mt-1 text-xs text-muted">{t('checksHint')}</p>
              </div>
              <textarea
                rows={3}
                value={checks ?? formatChecks(binding.verifyCommands)}
                placeholder={t('checksPlaceholder')}
                onChange={(e) => setChecks(e.target.value)}
                spellCheck={false}
                aria-label={t('checksHeading')}
                className="settings-field font-mono"
              />
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={checks === null}
                onClick={() =>
                  void act(async () => {
                    await workspaces.configure(projectId, {
                      verifyCommands: parseChecks(checks ?? ''),
                    });
                    setChecks(null);
                  })
                }
                className="self-start"
              >
                {t('saveChecks')}
              </Button>
            </section>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The session's working copy: make one, open the review, or remove it (session page). */
export function WorkingCopyPanel({
  sessionId,
  projectId,
}: {
  sessionId: string;
  projectId: string;
}) {
  const t = useTranslations('Files');
  const { workspaces } = useServices();
  const { binding } = useBinding(projectId);
  const [worktree, setWorktree] = useState<WorktreeView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    if (!workspaces) return setWorktree(null);
    setWorktree(await workspaces.worktree(sessionId).catch(() => null));
  }, [workspaces, sessionId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  if (!workspaces || worktree === undefined || binding === undefined) return null;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await reload();
      // The header and panels showing the copy follow it.
      window.dispatchEvent(new Event(WORKSPACE_CHANGED));
    } catch (failure) {
      setError(
        t('failed', { message: failure instanceof Error ? failure.message : String(failure) }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby="copy-heading"
      className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm"
    >
      <h3 id="copy-heading" className="text-sm font-semibold">
        {t('copyHeading')}
      </h3>
      {worktree?.missing ? (
        <p role="alert" className="text-xs text-danger">
          {t('copyMissing')}
        </p>
      ) : null}
      {worktree ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">
            {t('ready', { commit: worktree.baseCommit.slice(0, 8) })}
          </span>
          <Link
            to="/sessions/$sessionId/review"
            params={{ sessionId }}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent"
          >
            {t('review')}
          </Link>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('removeConfirm')))
                void act(() => workspaces.removeWorktree(sessionId));
            }}
            className="rounded border border-line px-2 py-1 text-xs"
          >
            {t('remove')}
          </button>
        </div>
      ) : !binding ? (
        <p className="text-xs text-muted">{t('noFolder')}</p>
      ) : !binding.trusted ? (
        <p className="text-xs text-warning">{t('notTrusted')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted">{t('copyIntro')}</p>
          <p className="text-xs text-warning">
            {t('createHint', { changed: binding.status?.changed ?? 0 })}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => workspaces.createWorktree(sessionId))}
            className="self-start rounded-md border border-accent px-3 py-1 text-xs text-accent"
          >
            {t('create', { head: binding.status?.head ?? 'HEAD' })}
          </button>
        </div>
      )}
      {worktree && !worktree.missing ? (
        <CheckpointPanel key={sessionId} sessionId={sessionId} />
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** What needs a person in this project (CR-013, WB-OBS-002); it empties as things are handled. */
export function InboxSection({ projectId }: { projectId: string }) {
  const t = useTranslations('Review');
  const tr = useTranslations('Recipe');
  const { workspaces } = useServices();
  const [items, setItems] = useState<InboxItemView[]>([]);
  useEffect(() => {
    if (!workspaces) return;
    let live = true;
    const load = () =>
      workspaces.inbox(projectId).then(
        (list) => live && setItems(list),
        () => {},
      );
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [workspaces, projectId]);
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="inbox-heading"
      className="flex flex-col gap-2 rounded-md border border-warning p-3"
    >
      <h2 id="inbox-heading" className="text-sm font-semibold">
        {t('inboxHeading')} ({items.length})
      </h2>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((item, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: items repeat per session and kind
            key={`${item.kind}-${item.sessionId}-${index}`}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              <span className="font-medium">{item.sessionTitle}</span> ·{' '}
              {t(`inbox.${item.kind}`, {
                detail:
                  item.kind === 'recipe_stopped'
                    ? tr(`reasons.${item.detail}`)
                    : (item.detail ?? ''),
              })}
            </span>
            {item.kind === 'recipe_stopped' && item.runId ? (
              <Link to="/runs/$runId" params={{ runId: item.runId }} className="text-xs underline">
                {t('open')}
              </Link>
            ) : item.kind === 'decision' && item.runId ? (
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: item.sessionId }}
                className="text-xs underline"
              >
                {t('open')}
              </Link>
            ) : item.kind === 'queued' ? (
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: item.sessionId }}
                className="text-xs underline"
              >
                {t('open')}
              </Link>
            ) : (
              <Link
                to="/sessions/$sessionId/review"
                params={{ sessionId: item.sessionId }}
                className="text-xs underline"
              >
                {t('open')}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
