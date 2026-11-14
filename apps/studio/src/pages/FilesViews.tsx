import type { VerifyCommand, WorkspaceBindingView, WorktreeView } from '@corral/client';
import { EmptyView, type EmptyViewAction, TermHint } from '@corral/react';
import { Button, fontWeights, Input, Switch, Textarea } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { desktop } from '../desktop.tsx';
import { useServices } from '../services.tsx';
import { CopyRemovalDialog } from '../workbench/CopyRemovalDialog.tsx';
import { DevelopmentMode } from '../workbench/DevelopmentMode.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { WORKSPACE_CHANGED } from '../workbench/workspaceEvents.ts';

// Work folders and working copies in Studio, on the local server or the demo's
// in-memory example folder.

export { WORKSPACE_CHANGED };

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

/**
 * The project's linked folder: undefined while it is read, null when there is none. An answer
 * counts only for the project it was asked for and only if no later read started, so switching
 * projects never shows the previous project's folder.
 */
export function useBinding(projectId: string | null) {
  const { workspaces } = useServices();
  const [read, setRead] = useState<{
    projectId: string | null;
    binding: WorkspaceBindingView | null;
  } | null>(null);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++latest.current;
    let binding: WorkspaceBindingView | null = null;
    if (workspaces && projectId) {
      try {
        binding = await workspaces.binding(projectId);
      } catch {
        binding = null;
      }
    }
    if (request === latest.current) setRead({ projectId, binding });
  }, [workspaces, projectId]);
  useEffect(() => {
    void reload();
    // Linking, unlinking or trusting elsewhere (settings overlay) changes what this shows.
    const changed = () => void reload();
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED, changed);
      latest.current += 1;
    };
  }, [reload]);
  const binding = read && read.projectId === projectId ? read.binding : undefined;
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
  const [pending, setPending] = useState(false);
  const runSettingsTask = useSettingsTask(`work-folder:${projectId}`);
  useSettingsForm({
    dirty: (mode === 'server' && !binding && Boolean(path)) || checks !== null,
    pending,
  });
  if (!workspaces || binding === undefined) return null;
  const act = async (work: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await runSettingsTask(work);
      await reload();
      window.dispatchEvent(new Event(WORKSPACE_CHANGED));
    } catch (failure) {
      setError(
        t('failed', { message: failure instanceof Error ? failure.message : String(failure) }),
      );
    } finally {
      setPending(false);
    }
  };
  const link = (event: FormEvent) => {
    event.preventDefault();
    void act(() => workspaces.bind(projectId, path.trim()));
  };

  return (
    <fieldset disabled={pending} className="flex min-w-0 flex-col gap-6">
      {mode === 'browser' ? <p className="text-body text-warning">{t('demoFolder')}</p> : null}
      {!binding ? (
        <form onSubmit={link} className="settings-row">
          <div>
            <h3>{t('pathLabel')}</h3>
            {path && mode !== 'browser' ? (
              <p className="truncate" title={path}>
                {path}
              </p>
            ) : null}
            {/* What linking grants, beside the action that grants it. */}
            <p>{t('linkObservesOnly')}</p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
            {mode === 'server' && !desktop ? (
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                spellCheck={false}
                aria-label={t('pathLabel')}
                className="font-mono sm:w-80"
              />
            ) : null}
            <div className="flex gap-2">
              {mode === 'browser' ? (
                <Button variant="tertiary" type="submit">
                  {t('linkExample')}
                </Button>
              ) : desktop ? (
                <>
                  <Button
                    variant="tertiary"
                    type="button"
                    onClick={() => {
                      if (!desktop) return;
                      void desktop.pickFolder().then((folder) => {
                        if (folder) setPath(folder);
                      });
                    }}
                  >
                    {t('chooseFolder')}
                  </Button>
                  <Button variant="tertiary" type="submit" disabled={!path.trim()}>
                    {t('link')}
                  </Button>
                </>
              ) : (
                <Button variant="tertiary" type="submit" disabled={!path.trim()}>
                  {t('link')}
                </Button>
              )}
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
              variant="tertiary"
              type="button"
              onClick={() => void act(() => workspaces.unbind(projectId))}
            >
              {t('unlink')}
            </Button>
          </section>
          <div className="settings-row flex-col items-start gap-1">
            <Switch
              label={binding.isGit ? t('trust') : t('trustFolderSwitch')}
              checked={binding.trusted}
              onToggle={() =>
                void act(() => workspaces.configure(projectId, { trusted: !binding.trusted }))
              }
            />
            <p className="text-caption">{binding.isGit ? t('trustHint') : t('trustFolderHint')}</p>
          </div>
          {binding.trusted ? (
            <section className="settings-surface flex flex-col gap-3">
              <div>
                <h3
                  className="text-subtitle"
                  style={{ fontVariationSettings: fontWeights.semibold }}
                >
                  {t('checksHeading')}
                </h3>
                <p className="mt-1 text-caption text-muted-foreground">{t('checksHint')}</p>
              </div>
              <Textarea
                rows={3}
                value={checks ?? formatChecks(binding.verifyCommands)}
                placeholder={t('checksPlaceholder')}
                onChange={(e) => setChecks(e.target.value)}
                spellCheck={false}
                aria-label={t('checksHeading')}
                className="font-mono"
              />
              <Button
                variant="tertiary"
                type="button"
                disabled={checks === null}
                onClick={() =>
                  void act(async () => {
                    await workspaces.configure(projectId, {
                      verifyCommands: parseChecks(checks ?? ''),
                    });
                    setChecks((current) => (current === checks ? null : current));
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
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
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
  const navigation = useSettingsNavigation();
  const [worktree, setWorktree] = useState<WorktreeView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const reload = useCallback(async () => {
    if (!workspaces) return setWorktree(null);
    setWorktree(await workspaces.worktree(sessionId).catch(() => null));
  }, [workspaces, sessionId]);
  useEffect(() => {
    void reload();
    const changed = () => void reload();
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
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
  // Without a copy this is an empty view with its one next step: link the folder, trust it,
  // or make the copy.
  if (!worktree) {
    const folderSettings = <Link {...navigation.link('workspace', projectId)} />;
    // The button names the commit the copy starts from. The one thing it cannot say is that
    // uncommitted changes in the folder stay behind, so that is told only when there are some.
    const left = binding?.status?.changed ?? 0;
    const next: { text?: string; action: EmptyViewAction } = !binding
      ? { text: t('noFolder'), action: { label: t('openFolderSettings'), render: folderSettings } }
      : !binding.trusted
        ? { text: t('notTrusted'), action: { label: t('openTrust'), render: folderSettings } }
        : {
            ...(left > 0 ? { text: t('createHint', { changed: left }) } : {}),
            action: {
              label: t('create', { head: binding.status?.head ?? 'HEAD' }),
              disabled: busy,
              onClick: () => void act(() => workspaces.createWorktree(sessionId)),
            },
          };
    return (
      <section aria-label={t('copyHeading')} className="flex flex-col gap-2">
        {/* The pane's one place for the Paddock term (glossary.md): after the empty title. */}
        <EmptyView
          title={t('noCopyTitle')}
          titleAction={<TermHint term="paddock" />}
          text={next.text}
          action={next.action}
        />
        {error ? (
          <p role="alert" className="m-0 text-center text-caption text-destructive">
            {error}
          </p>
        ) : null}
      </section>
    );
  }
  return (
    <section
      aria-labelledby="copy-heading"
      className="flex flex-col gap-2 rounded-md fill-group p-3 text-body"
    >
      {/* The pane's one place for the Paddock term (glossary.md): after its title. */}
      <div className="flex items-center gap-1">
        <h3
          id="copy-heading"
          className="text-subtitle"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {t('copyHeading')}
        </h3>
        <TermHint term="paddock" />
      </div>
      {worktree?.missing ? (
        <p role="alert" className="text-caption text-danger">
          {t('copyMissing')}
        </p>
      ) : null}
      {!worktree.missing ? <DevelopmentMode sessionId={sessionId} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption text-muted-foreground">
          {t('ready', { commit: worktree.baseCommit.slice(0, 8) })}
        </span>
        <Button
          variant="primary"
          render={<Link to="/sessions/$sessionId/review" params={{ sessionId }} />}
        >
          {t('review')}
        </Button>
        <Button type="button" variant="tertiary" disabled={busy} onClick={() => setRemoving(true)}>
          {t('remove')}
        </Button>
        <CopyRemovalDialog
          open={removing}
          sessionId={sessionId}
          projectId={projectId}
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            setRemoving(false);
            void act(async () => {});
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
