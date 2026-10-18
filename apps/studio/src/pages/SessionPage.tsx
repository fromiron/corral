import type { FileChangeView } from '@corral/client';
import type { RoleRunOverrides } from '@corral/contracts';
import {
  type HarnessOverrides,
  type RunReference,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import type {
  CorralSummary,
  RunProjection,
  RunSummary,
  SessionEntry,
  SessionIntent,
  WorkSession,
} from '@corral/core';
import { ApprovalPanel, RunActions, runResults, StatusBadge } from '@corral/react';
import {
  ArrowUp,
  AtSign,
  Ellipsis,
  FileDiff,
  MessageSquare,
  PanelRight,
  Square,
  X,
} from '@corral/react/icons';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  Select,
  Tooltip,
} from '@corral/react/ui';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import {
  createContext,
  type KeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { type AppCommand, useRegisterCommands, useRegisteredCommands } from '../commandRegistry.ts';
import { projectsChanged, setCurrentProject } from '../projects.ts';
import { type SessionSearch, sessionRoute, validateSessionSearch } from '../router.tsx';
import { useServices } from '../services.tsx';
import { sendKeyLabel, shortcutLabel } from '../shortcuts.ts';
import { ChatView } from '../workbench/ChatView.tsx';
import { ComposerInput } from '../workbench/ComposerInput.tsx';
import { ComposerSurface } from '../workbench/ComposerSurface.tsx';
import { type IntentLock, resolveIntent } from '../workbench/composerIntent.ts';
import { type MentionItem, mentionToken, pickedReferences } from '../workbench/composerMenu.ts';
import { FilePanel, type FileReference } from '../workbench/FilePanel.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { isSendKey, usePreferences } from '../workbench/preferences.ts';
import { EDIT_REQUEST, editRequest, RefusalHelp } from '../workbench/RefusalHelp.tsx';
import { RunHarnessOverrides } from '../workbench/RunHarnessOverrides.tsx';
import { RunMessage } from '../workbench/RunMessage.tsx';
import { RunRoleOverrides } from '../workbench/RunRoleOverrides.tsx';
import {
  COMPOSER_DRAFT_SENT,
  clearSentComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from '../workbench/sessionDraft.ts';
import { TabRow } from '../workbench/TabRow.tsx';
import { TopbarActions } from '../workbench/TopbarSlot.tsx';
import { useMentionSearch } from '../workbench/useMentionSearch.ts';
import {
  type ProfileInfo,
  type RoleModel,
  useModelProfiles,
  useTeamRoles,
} from '../workbench/useModels.ts';
import { useRunMode } from '../workbench/useRunMode.ts';
import { useBinding, WORKSPACE_CHANGED, WorkingCopyPanel } from './FilesViews.tsx';
import { Checks } from './ReviewPage.tsx';
import { RunDetail } from './RunPage.tsx';
import { useRemembered, WorkbenchLayout } from './Workbench.tsx';

// A work session (CR-011, roadmap 23–24): what was asked, the runs it started, the queue, and
// one input box whose intent is chosen, never guessed.

const newCommandId = () => `cmd_${globalThis.crypto.randomUUID()}`;

/** The session's runs, kept current while one is working. */
function useSessionRuns(sessionId: string) {
  const { transport } = useServices();
  const [all, setAll] = useState<RunSummary[]>([]);
  const [tick, setTick] = useState(0);
  // Unreachable server: run states are unknown, not finished (02-UX-Spec §8).
  const [lost, setLost] = useState(false);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    void tick;
    let live = true;
    transport.listRuns().then(
      (runs) => {
        if (!live) return;
        setAll(runs);
        setLost(false);
      },
      () => live && setLost(true),
    );
    return () => {
      live = false;
    };
  }, [transport, tick]);
  const active = all.find((r) => !TERMINAL_RUN_STATUSES.has(r.status)) ?? null;
  useEffect(() => {
    if (!active && !lost) return;
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [active, lost, refresh]);
  const runs = all.filter((r) => r.sessionId === sessionId).reverse();
  return { runs, active, refresh, lost };
}

export type SessionPanel = 'files' | 'changes' | 'artifacts' | 'checks' | 'run';
const PANELS: SessionPanel[] = ['changes', 'files', 'artifacts', 'checks', 'run'];

/**
 * A session as a workbench (02-UX-Spec §2–§3; Workbench polish P1): the conversation in the
 * middle and, only when asked for, one side panel with Changes / Files / Results / Checks / Run.
 * The session's own actions sit in the top bar. Choices live in the address, so they survive
 * reloads and the back button.
 */
export function SessionPage() {
  const tw = useTranslations('Workbench');
  const { session, corrals } = sessionRoute.useLoaderData();
  const urlSearch = sessionRoute.useSearch();
  const [savedView, rememberView] = useRemembered<Record<string, unknown>>(
    `corral:session-view:v1:${session.sessionId}`,
    {},
  );
  const search = {
    ...validateSessionSearch(savedView && typeof savedView === 'object' ? savedView : {}),
    ...urlSearch,
  };
  const viewKey = JSON.stringify(search);
  useEffect(() => rememberView(JSON.parse(viewKey)), [viewKey, rememberView]);
  const navigate = useNavigate({ from: '/sessions/$sessionId' });
  const { runs, active, refresh, lost } = useSessionRuns(session.sessionId);
  useEffect(() => setCurrentProject(session.projectId), [session.projectId]);
  const team = corrals.find((c) => c.corralId === session.corralId) ?? null;
  const ts = useTranslations('Sessions');
  const panel = search.panel;
  const [pendingReference, setReference] = useState<{
    sessionId: string;
    value: FileReference;
  } | null>(null);
  const reference =
    pendingReference?.sessionId === session.sessionId ? pendingReference.value : null;
  const setSearch = (patch: Partial<typeof search>) => {
    const next = validateSessionSearch({
      ...search,
      ...patch,
      ...(patch.view === 'results' ? { artifact: undefined } : {}),
    });
    rememberView({ ...next });
    void navigate({ search: () => next });
  };
  const changes = useSessionChanges(session.sessionId, runs);

  return (
    <>
      <SessionActions
        session={session}
        corrals={corrals}
        team={team}
        changes={changes}
        panel={panel}
        onPanel={(value) => setSearch({ panel: value })}
      />
      <WorkbenchLayout
        key={session.sessionId}
        storageKey={session.sessionId}
        panelOpen={Boolean(panel)}
        onPanelClose={() => setSearch({ panel: undefined })}
        panelTabs={
          panel ? (
            <TabRow
              id="session-panels"
              label={tw('panelTabs')}
              values={PANELS}
              current={panel}
              text={(value) => tw(`panel.${value}`)}
              onChoose={(value) => setSearch({ panel: value })}
            />
          ) : null
        }
        main={
          <div className="flex min-h-0 flex-1 flex-col">
            {lost ? (
              <div
                role="alert"
                className="flex items-center gap-2 border-b border-danger/40 bg-danger/5 px-4 py-2 text-xs text-danger"
              >
                {ts('connectionLost')}
                <Button variant="outline" size="xs" onClick={refresh}>
                  {ts('retry')}
                </Button>
              </div>
            ) : null}
            <WorkTab
              session={session}
              team={team}
              corrals={corrals}
              runs={runs}
              active={active}
              onChange={refresh}
              reference={reference}
              onReferenceUsed={() => setReference(null)}
              onPanel={(value, run) => setSearch({ panel: value, ...run })}
            />
          </div>
        }
        panel={
          panel ? (
            <div
              role="tabpanel"
              id={`session-panels-${panel}-panel`}
              aria-labelledby={`session-panels-${panel}-tab`}
              aria-label={tw(`panel.${panel}`)}
              className={
                panel === 'run' ? 'flex h-full min-h-0 flex-col' : 'flex flex-col gap-3 p-3'
              }
            >
              {panel === 'files' ? (
                <FilePanel
                  key={session.sessionId}
                  projectId={session.projectId}
                  sessionId={session.sessionId}
                  onReference={(value) => setReference({ sessionId: session.sessionId, value })}
                />
              ) : panel === 'changes' ? (
                <ChangesPanel session={session} files={changes} />
              ) : panel === 'artifacts' ? (
                <ArtifactsPanel
                  runs={runs}
                  onOpen={(runId, result) =>
                    setSearch({ panel: 'run', run: runId, view: 'results', result })
                  }
                />
              ) : panel === 'checks' ? (
                <ChecksPanel session={session} />
              ) : (
                <RunPanel runs={runs} search={search} setSearch={setSearch} />
              )}
            </div>
          ) : null
        }
      />
    </>
  );
}

/** The session's changed files in its working copy, or null without one. */
function useSessionChanges(sessionId: string, runs: RunSummary[]) {
  const { workspaces } = useServices();
  const [files, setFiles] = useState<FileChangeView[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const changed = () => setTick((n) => n + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  // Refresh when a run of the session starts or ends.
  const key = runs.map((r) => `${r.runId}:${r.status}`).join(',');
  useEffect(() => {
    void key;
    void tick;
    if (!workspaces) return;
    let live = true;
    // Without a working copy there is nothing to compare; asking would only be refused.
    void (async () => {
      const copy = await workspaces.worktree(sessionId).catch(() => null);
      if (!copy || copy.missing) return live && setFiles(null);
      const changes = await workspaces.changes(sessionId, { kind: 'session' });
      if (live) setFiles(changes.files);
    })().catch(() => live && setFiles(null));
    return () => {
      live = false;
    };
  }, [workspaces, sessionId, key, tick]);
  return files;
}

/** The session's own actions, in the top bar: changes, the side panel, and a menu. */
function SessionActions({
  session,
  corrals,
  team,
  changes,
  panel,
  onPanel,
}: {
  session: WorkSession;
  corrals: CorralSummary[];
  team: CorralSummary | null;
  changes: FileChangeView[] | null;
  panel: SessionPanel | undefined;
  onPanel: (panel: SessionPanel | undefined) => void;
}) {
  const t = useTranslations('Sessions');
  const tw = useTranslations('Workbench');
  const td = useTranslations('Desktop');
  const { repository } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const update = async (change: {
    corralId?: string | null;
    pinned?: boolean;
    archived?: boolean;
    title?: string;
  }) => {
    const result = await repository.updateSession(session.sessionId, {
      ...change,
      expectedRevision: session.revision,
    });
    if (!result.ok) {
      setError(t('failed', { message: result.message }));
      return false;
    }
    setError(null);
    projectsChanged();
    await router.invalidate();
    return true;
  };
  const tcmd = useTranslations('Commands');
  const { workspaces } = useServices();
  const panelGroup = tcmd('groups.panel');
  const sessionGroup = tcmd('groups.session');
  useRegisterCommands('session', [
    {
      id: 'panel:toggle',
      title: tcmd('togglePanel'),
      group: panelGroup,
      shortcutId: 'view.panel',
      shortcut: shortcutLabel('view.panel'),
      run: () => onPanel(panel ? undefined : 'changes'),
    },
    ...(
      [
        ['changes', 'changes'],
        ['files', 'files'],
        ['artifacts', 'results'],
        ['checks', 'checks'],
        ['run', 'run'],
      ] as const
    ).map(
      ([value, slash]): AppCommand => ({
        id: `panel:${value}`,
        title: tcmd('openPanel', { panel: tw(`panel.${value}`) }),
        group: panelGroup,
        slash,
        run: () => onPanel(value),
      }),
    ),
    {
      id: 'session:review',
      title: tcmd('review'),
      group: sessionGroup,
      slash: 'review',
      disabled: !workspaces,
      hint: workspaces ? undefined : tw('serverOnly'),
      run: () =>
        navigate({ to: '/sessions/$sessionId/review', params: { sessionId: session.sessionId } }),
    },
    {
      id: 'session:copy',
      title: tcmd('makeCopy'),
      group: sessionGroup,
      slash: 'copy',
      disabled: !workspaces,
      hint: workspaces ? undefined : tw('serverOnly'),
      run: async () => {
        if (!workspaces) return;
        try {
          const existing = await workspaces.worktree(session.sessionId).catch(() => null);
          if (existing && !existing.missing) return setError(tcmd('copyExists'));
          await workspaces.createWorktree(session.sessionId);
          window.dispatchEvent(new Event(WORKSPACE_CHANGED));
          onPanel('changes');
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      },
    },
    {
      id: 'session:rename',
      title: tcmd('rename'),
      group: sessionGroup,
      slash: 'rename',
      run: () => setRenaming(session.title),
    },
    {
      id: 'session:pin',
      title: session.pinned ? tcmd('unpin') : tcmd('pin'),
      group: sessionGroup,
      slash: session.pinned ? 'unpin' : 'pin',
      run: () => void update({ pinned: !session.pinned }),
    },
    {
      id: 'session:archive',
      title: session.archivedAt ? tcmd('restore') : tcmd('archive'),
      group: sessionGroup,
      slash: session.archivedAt ? 'restore' : 'archive',
      run: () => void update({ archived: !session.archivedAt }),
    },
  ]);
  return (
    <TopbarActions>
      {error ? (
        <p role="alert" className="max-w-64 truncate text-xs text-danger" title={error}>
          {error}
        </p>
      ) : null}
      {changes && changes.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={panel === 'changes'}
          onClick={() => onPanel(panel === 'changes' ? undefined : 'changes')}
          className="gap-1.5 text-muted-foreground"
        >
          <FileDiff />
          {tw('changeCount', { count: changes.length })}
        </Button>
      ) : null}
      <Tooltip
        content={panel ? tw('collapsePanel') : tw('expandPanel')}
        shortcut={shortcutLabel('view.panel')}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={panel ? tw('collapsePanel') : tw('expandPanel')}
          aria-pressed={Boolean(panel)}
          onClick={() => onPanel(panel ? undefined : 'changes')}
        >
          <PanelRight />
        </Button>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={td('sessionActions', { title: session.title })}
            />
          }
        >
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          <MenuItem onClick={() => setRenaming(session.title)}>{td('rename')}</MenuItem>
          <MenuSub>
            <MenuSubTrigger>
              {t('chooseTeam')}
              <span className="ml-auto max-w-28 truncate pl-3 text-xs text-muted-foreground">
                {team?.name ?? t('noTeam')}
              </span>
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup
                value={team?.corralId ?? ''}
                onValueChange={(value) => void update({ corralId: String(value) || null })}
              >
                <MenuRadioItem value="" closeOnClick>
                  {t('noTeam')}
                </MenuRadioItem>
                {corrals.map((c) => (
                  <MenuRadioItem key={c.corralId} value={c.corralId} closeOnClick>
                    {c.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          {team ? (
            <MenuItem
              onClick={() =>
                void navigate({
                  to: '/corrals/$corralId/edit',
                  params: { corralId: team.corralId },
                  search: { fromSession: session.sessionId },
                })
              }
            >
              {t('editTeam')}
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => void update({ pinned: !session.pinned })}>
            {session.pinned ? t('unpin') : t('pin')}
          </MenuItem>
          <MenuItem onClick={() => void update({ archived: !session.archivedAt })}>
            {session.archivedAt ? t('restore') : t('archive')}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{td('rename')}</DialogTitle>
            <DialogDescription>{td('renameHint')}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label={td('sessionTitle')}
              value={renaming ?? ''}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && renaming?.trim())
                  void update({ title: renaming }).then((ok) => ok && setRenaming(null));
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={!renaming?.trim()}
              onClick={() =>
                void update({ title: renaming ?? '' }).then((ok) => ok && setRenaming(null))
              }
            >
              {td('save')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </TopbarActions>
  );
}

/** The conversation: what was asked, the runs it started, decisions waiting, and the input box. */
function WorkTab({
  session,
  team,
  corrals,
  runs,
  active,
  onChange,
  reference,
  onReferenceUsed,
  onPanel,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  corrals: CorralSummary[];
  runs: RunSummary[];
  active: RunSummary | null;
  onChange: () => void;
  reference: FileReference | null;
  onReferenceUsed: () => void;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
}) {
  const t = useTranslations('Sessions');
  // Entries in order; runs that no entry names (started elsewhere) are shown after them.
  const named = new Set(session.entries.flatMap((e) => (e.runId ? [e.runId] : [])));
  const loose = runs.filter((r) => !named.has(r.runId));
  const queued = session.entries.filter((e) => e.state === 'queued');
  const runChecks = useRunChecks(session.sessionId, runs);
  const td = useTranslations('Desktop');
  return (
    <RunChecks.Provider value={runChecks}>
      <ChatView
        sessionId={session.sessionId}
        composer={
          <Composer
            key={session.sessionId}
            session={session}
            team={team}
            corrals={corrals}
            runs={runs}
            active={active}
            queued={queued}
            onChange={onChange}
            reference={reference}
            onReferenceUsed={onReferenceUsed}
          />
        }
      >
        <section aria-label={t('heading')}>
          {session.entries.length === 0 && loose.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 py-10 text-center">
              <MessageSquare size={28} strokeWidth={1.25} className="text-muted" />
              <h3 className="text-xl font-medium tracking-tight">{td('noRequests')}</h3>
              <p className="max-w-md text-sm text-muted">
                {session.objective ? session.objective : td('startHint')}
              </p>
            </div>
          ) : null}
          {session.entries
            .filter((e) => e.state !== 'queued' && e.state !== 'dismissed')
            .map((entry) => (
              <EntryCard key={entry.entryId} entry={entry} runs={runs} onPanel={onPanel} />
            ))}
          {loose.map((run) => (
            <RunCard key={run.runId} run={run} onPanel={onPanel} />
          ))}
        </section>
        {active && active.sessionId === session.sessionId ? (
          <ActiveDecisions runId={active.runId} onPanel={onPanel} />
        ) : null}
      </ChatView>
    </RunChecks.Provider>
  );
}

/** Run detail in the side panel: the chosen run (newest by default) with its own views. */
function RunPanel({
  runs,
  search,
  setSearch,
}: {
  runs: RunSummary[];
  search: SessionSearch;
  setSearch: (patch: Partial<SessionSearch>) => void;
}) {
  const tw = useTranslations('Workbench');
  const ts = useTranslations('Status');
  const runId =
    search.run && runs.some((r) => r.runId === search.run) ? search.run : runs.at(-1)?.runId;
  if (!runId) return <p className="p-4 text-sm text-muted">{tw('noRuns')}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line/50 px-3 py-1.5">
        <Select
          label={tw('chooseRun')}
          size="xs"
          variant="ghost"
          value={runId}
          onValueChange={(value) =>
            setSearch({
              run: value,
              execution: undefined,
              artifact: undefined,
              view: undefined,
              result: undefined,
            })
          }
          options={[...runs].reverse().map((r, index) => ({
            value: r.runId,
            label: `${tw('runNumber', { number: runs.length - index })} · ${ts(r.status)}`,
            hint: r.runId,
          }))}
        />
      </div>
      <div className="min-h-0 flex-1">
        <RunDetail
          key={runId}
          runId={runId}
          embedded
          compact
          search={{
            execution: search.execution,
            artifact: search.artifact,
            view: search.view,
            result: search.result,
          }}
          setSearch={(patch) => setSearch({ run: runId, ...patch })}
        />
      </div>
    </div>
  );
}

/** Changes: the working copy and its files for the whole session; the review screen for more. */
function ChangesPanel({
  session,
  files,
}: {
  session: WorkSession;
  files: FileChangeView[] | null;
}) {
  const tw = useTranslations('Workbench');
  const tf = useTranslations('Files');
  const { workspaces } = useServices();
  if (!workspaces) return <p className="text-xs text-muted">{tw('serverOnly')}</p>;
  return (
    <>
      <WorkingCopyPanel sessionId={session.sessionId} projectId={session.projectId} />
      {files === null ? (
        <p className="text-xs text-muted">{tw('noCopyChanges')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">{tw('changeCount', { count: files.length })}</p>
          <ul className="flex flex-col text-xs">
            {files.slice(0, 50).map((f) => (
              <li key={f.path}>
                <Link
                  to="/sessions/$sessionId/review"
                  params={{ sessionId: session.sessionId }}
                  search={{ file: f.path }}
                  className="flex items-baseline gap-2 rounded px-1.5 py-1 hover:bg-subtle"
                >
                  <span className="min-w-0 flex-1 break-all font-mono">{f.path}</span>
                  <span className="shrink-0 text-muted">
                    {tf(`status.${f.status}`)}
                    {f.additions !== null ? ` +${f.additions} −${f.deletions ?? 0}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            className="self-start"
            render={
              <Link to="/sessions/$sessionId/review" params={{ sessionId: session.sessionId }} />
            }
          >
            {tw('expandReview')}
          </Button>
        </div>
      )}
    </>
  );
}

/** Results use the same final/partial classification as the conversation. */
function ArtifactsPanel({
  runs,
  onOpen,
}: {
  runs: RunSummary[];
  onOpen: (runId: string, artifactVersionId: string) => void;
}) {
  const tw = useTranslations('Workbench');
  const tr = useTranslations('Results');
  const td = useTranslations('Desktop');
  const ta = useTranslations('Artifact');
  const { transport } = useServices();
  type Item = {
    runId: string;
    id: string;
    label: string;
    kind: 'final' | 'partial' | 'intermediate';
  };
  const [items, setItems] = useState<Item[]>([]);
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const ended = [...runs].reverse().filter((run) => TERMINAL_RUN_STATUSES.has(run.status));
  const key = ended
    .slice(0, count)
    .map((run) => run.runId)
    .join(',');
  useEffect(() => {
    void retry;
    let live = true;
    setLoading(true);
    setFailed(false);
    void (async () => {
      const found: Item[] = [];
      for (const runId of key ? key.split(',') : []) {
        const { projection } = await transport.getSnapshot(runId);
        if (!live) return;
        const results = runResults(projection);
        for (const artifact of [
          ...results.final,
          ...results.intermediate.map((group) => group.latest),
        ]) {
          found.push({
            runId,
            id: artifact.artifactVersionId,
            label: `${artifact.name} v${artifact.version}`,
            kind: results.final.includes(artifact)
              ? 'final'
              : results.kind === 'partial'
                ? 'partial'
                : 'intermediate',
          });
        }
      }
      if (live) setItems(found);
    })()
      .catch(() => {
        if (live) setFailed(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [transport, key, retry]);
  if (loading)
    return (
      <p role="status" className="text-xs text-muted">
        {ta('loading')}
      </p>
    );
  if (failed)
    return (
      <div role="alert" className="space-y-2 text-xs text-danger">
        <p>{td('resultUnavailable')}</p>
        <Button variant="outline" size="xs" onClick={() => setRetry((value) => value + 1)}>
          {td('retryResult')}
        </Button>
      </div>
    );
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-xs text-muted">{tw('artifactsEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {items.map((item) => (
            <li key={`${item.runId}:${item.id}`}>
              <button
                type="button"
                onClick={() => onOpen(item.runId, item.id)}
                className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-subtle"
              >
                <span className="text-xs text-muted">{tr(item.kind)}</span>
                <span className="font-medium">{item.label}</span>
                <span
                  className="max-w-full truncate font-mono text-xs text-muted"
                  title={item.runId}
                >
                  {item.runId}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {ended.length > count ? (
        <Button variant="ghost-muted" size="xs" onClick={() => setCount((value) => value + 10)}>
          {td('moreResults', { count: ended.length - count })}
        </Button>
      ) : null}
    </div>
  );
}

/** Checks: the agreed commands and their results, as on the review screen. */
function ChecksPanel({ session }: { session: WorkSession }) {
  const tw = useTranslations('Workbench');
  const { workspaces } = useServices();
  const { binding } = useBinding(session.projectId);
  if (!workspaces) return <p className="text-xs text-muted">{tw('serverOnly')}</p>;
  return (
    <>
      <Checks sessionId={session.sessionId} binding={binding ?? null} changed={0} />
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        render={<Link to="/sessions/$sessionId/review" params={{ sessionId: session.sessionId }} />}
      >
        {tw('expandReview')}
      </Button>
    </>
  );
}

/** Decisions the session's working run waits for, answered here (WB-OBS-002). */
function ActiveDecisions({
  runId,
  onPanel,
}: {
  runId: string;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
}) {
  const { session } = useServices();
  useEffect(() => {
    void session.getState().open(runId);
  }, [session, runId]);
  return (
    <>
      <RunActions session={session} compact />
      <ApprovalPanel
        session={session}
        onOpenArtifact={(id) => onPanel('run', { run: runId, view: 'results', result: id })}
      />
    </>
  );
}

function EntryCard({
  entry,
  runs,
  onPanel,
}: {
  entry: SessionEntry;
  runs: RunSummary[];
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
}) {
  const t = useTranslations('Sessions');
  const format = useFormatter();
  const run = entry.runId ? runs.find((r) => r.runId === entry.runId) : undefined;
  const when = format.dateTime(new Date(entry.createdAt), {
    timeStyle: 'short',
    dateStyle: 'short',
  });
  // A plain follow-up needs no label; queue, instruction and question say what they were.
  const label = entry.intent === 'next' ? null : t(`intentShort.${entry.intent}`);
  const state =
    entry.state === 'started' || entry.state === 'sent' ? null : t(`state.${entry.state}`);
  return (
    <article data-testid={`entry-${entry.entryId}`} className="chat-turn flex flex-col gap-4">
      <div className="user-message" title={when}>
        {label || state ? (
          <p className="mb-1 text-2xs font-medium text-muted">
            {[label, state].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap text-sm leading-6">{entry.text}</p>
        <span className="sr-only">
          {t('youAsked', { intent: t(`intent.${entry.intent}`) })} · {t(`state.${entry.state}`)} ·{' '}
          {when}
        </span>
      </div>
      {entry.detail && entry.state === 'refused' ? (
        <RefusalHelp message={entry.detail} onEdit={() => editRequest(entry.text)} />
      ) : entry.detail ? (
        <p role="note" className="text-xs text-danger">
          {entry.detail}
        </p>
      ) : null}
      {run && entry.intent !== 'steer' ? <RunCard run={run} nested onPanel={onPanel} /> : null}
      {entry.intent === 'steer' && entry.runId ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <DeliveryStatus
            runId={entry.runId}
            commandId={entry.commandId ?? null}
            executionId={entry.executionId ?? null}
          />
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() =>
              onPanel('run', {
                run: entry.runId ?? undefined,
                view: 'run',
                execution: entry.executionId ?? undefined,
              })
            }
          >
            {t('openRun')}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** A run with its status and, once it has one, its final result. */
/** Each ended run's latest check of its own end state, when the session has checks. */
type RunCheck = { name: string; state: 'running' | 'passed' | 'failed' | 'error' } | null;
const RunChecks = createContext<{ known: boolean; of: (runId: string) => RunCheck }>({
  known: false,
  of: () => null,
});

/** Matches checks to runs by tree: a check counts for a run only if it ran on the run's end. */
function useRunChecks(sessionId: string, runs: RunSummary[]) {
  const { workspaces } = useServices();
  const [value, setValue] = useState<{ known: boolean; map: Map<string, RunCheck> }>({
    known: false,
    map: new Map(),
  });
  const key = runs.map((r) => `${r.runId}:${r.status}`).join(',');
  useEffect(() => {
    void key;
    if (!workspaces) return;
    let live = true;
    void (async () => {
      const copy = await workspaces.worktree(sessionId).catch(() => null);
      if (!copy) return;
      const [snapshots, checks] = await Promise.all([
        workspaces.runSnapshots(sessionId),
        workspaces.verifications(sessionId),
      ]);
      const map = new Map<string, RunCheck>();
      for (const snapshot of snapshots.filter((x) => x.phase === 'end')) {
        const check = checks.find((c) => c.tree === snapshot.tree);
        map.set(snapshot.runId, check ? { name: check.name, state: check.state } : null);
      }
      if (live) setValue({ known: true, map });
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaces, sessionId, key]);
  return { known: value.known, of: (runId: string) => value.map.get(runId) ?? null };
}

/**
 * A run in the session (02-UX-Spec §3): one line with its state, the agent's own words kept
 * apart from facts, and what can be done next. Details open in the side panel.
 */
function RunCard({
  run,
  nested = false,
  onPanel,
}: {
  run: RunSummary;
  nested?: boolean;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
}) {
  const t = useTranslations('Sessions');
  const ts = useTranslations('Status');
  const tf = useTranslations('Files');
  const checks = useContext(RunChecks);
  const check = checks.of(run.runId);
  const ended = TERMINAL_RUN_STATUSES.has(run.status);
  return (
    <section
      aria-label={run.runId}
      data-testid={`run-card-${run.runId}`}
      className={`flex min-w-0 flex-col gap-3 ${nested ? '' : 'mb-8'}`}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <StatusBadge status={run.status} />
        <span className="sr-only">{run.runId}</span>
        {ended && checks.known ? (
          <span className="text-muted" data-testid="run-check">
            {check
              ? t('checked', { name: check.name, state: tf(`checkState.${check.state}`) })
              : t('notChecked')}
          </span>
        ) : null}
        <Button
          variant="ghost-muted"
          size="xs"
          className="ml-auto"
          onClick={() => onPanel('run', { run: run.runId, view: 'run' })}
        >
          {t('openRun')}
        </Button>
      </div>
      {ended && run.status !== 'succeeded' ? (
        <p role="note" className="text-xs text-warning">
          {t('didNotFinish', { status: ts(run.status) })}
        </p>
      ) : null}
      <RunMessage runId={run.runId} sessionId={run.sessionId ?? null} live={!ended} />
      {/* Only a session with a working copy has changes to review (its checks are known). */}
      {ended && checks.known && run.sessionId ? (
        <div>
          <Button
            variant="outline"
            size="xs"
            render={
              <Link
                to="/sessions/$sessionId/review"
                params={{ sessionId: run.sessionId }}
                search={{ scope: 'run', runId: run.runId }}
              />
            }
          >
            <FileDiff />
            {t('reviewChanges')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Where an instruction is now, from the run's own record of it (02-UX-Spec §7). */
/**
 * Whom an instruction was for, when it applies, and where it is now (UX-08), from the run's
 * own record. It stays readable after the composer moves on to another execution.
 */
function DeliveryStatus({
  runId,
  commandId,
  executionId,
}: {
  runId: string;
  commandId: string | null;
  executionId: string | null;
}) {
  const t = useTranslations('Sessions');
  const ts = useTranslations('Transcript.instruction');
  const { transport } = useServices();
  const [status, setStatus] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([transport.getSnapshot(runId), transport.getRunDefinition(runId)]).then(
      ([{ projection }, definition]) => {
        const execution = executionId ? projection.executions[executionId] : undefined;
        if (!live || !execution) return;
        const node = definition?.nodes.find((n) => n.id === execution.nodeId);
        setRecipient(
          `${node?.label ?? execution.nodeId} · #${projection.executionOrder.indexOf(execution.executionId) + 1}`,
        );
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [transport, runId, executionId]);
  useEffect(() => {
    if (!commandId) return;
    let live = true;
    const read = () =>
      transport.getSnapshot(runId).then(
        ({ projection }) => {
          const directive = Object.values(projection.directives).find(
            (d) => d.commandId === commandId,
          );
          if (live) setStatus(directive?.status ?? null);
          return directive?.status ?? null;
        },
        () => null,
      );
    void read();
    const timer = setInterval(() => {
      void read().then((now) => {
        if (now && !['accepted', 'queued', 'attached_to_request'].includes(now))
          clearInterval(timer);
      });
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [transport, runId, commandId]);
  return (
    <>
      <span data-testid="recipient" className="font-medium text-text" title={executionId ?? ''}>
        → {recipient ?? executionId}
      </span>
      <span>{t('appliesAt')}</span>
      {status ? <span data-testid="delivery">{t('delivery', { status: ts(status) })}</span> : null}
    </>
  );
}

function finalResultId(projection: RunProjection): string | null {
  return projection.output?.artifactVersionIds[0] ?? null;
}

function Composer({
  session,
  team,
  corrals,
  runs,
  active,
  queued,
  onChange,
  reference,
  onReferenceUsed,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  corrals: CorralSummary[];
  runs: RunSummary[];
  active: RunSummary | null;
  queued: SessionEntry[];
  onChange: () => void;
  reference: FileReference | null;
  onReferenceUsed: () => void;
}) {
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  const navigation = useSettingsNavigation();
  const tr = useTranslations('Reins');
  const services = useServices();
  const { repository, transport, mode, live } = services;
  const prefs = usePreferences();
  const router = useRouter();
  // UX-02: the draft comes back with its intent, target and exact references.
  const [restored] = useState(() => readComposerDraft(session.sessionId));
  const [text, setText] = useState(restored.text);
  const [chosen, setChosen] = useState<SessionIntent | null>(null);
  const [target, setTarget] = useState<string>('');
  // UX-01: what the request is (and for whom) is fixed once typing starts.
  const [lock, setLock] = useState<IntentLock | null>(
    restored.text && restored.intent ? { intent: restored.intent, target: restored.target } : null,
  );
  const modeChoice = useRunMode(session.projectId, 'session', session.sessionId);
  const { mode: runMode, select: setRunMode } = modeChoice;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UX-04: why the last request did not start; the text stays in the box to send again.
  const [refusal, setRefusal] = useState<{
    message: string;
    code?: string | undefined;
    network?: boolean;
  } | null>(null);
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const [targetTick, setTargetTick] = useState(0);
  const [picked, setPicked] = useState<MentionItem[]>(restored.references);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  // Names of executions seen, so an instruction for one that ended still says whom it was for.
  const targetNames = useRef(
    new Map<string, string>(
      restored.target && restored.targetLabel ? [[restored.target, restored.targetLabel]] : [],
    ),
  );
  const [confirmStop, setConfirmStop] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  // UX-06: which model each role uses, and whether it is connected.
  const profiles = useModelProfiles();
  const roles = useTeamRoles(team);
  const harnessKey = JSON.stringify([session.sessionId, team?.corralId, team?.definitionRevision]);
  const [runStyles, setRunStyles] = useState<{ key: string; value: HarnessOverrides } | null>(null);
  const [roleChoices, setRoleChoices] = useState<{ key: string; value: RoleRunOverrides } | null>(
    null,
  );
  const roleOverrides = roleChoices?.key === harnessKey ? roleChoices.value : {};
  const harnessOverrides = runStyles?.key === harnessKey ? runStyles.value : {};
  const [recall, setRecall] = useState(-1);
  const input = useRef<HTMLTextAreaElement>(null);
  const ownActive = active && active.sessionId === session.sessionId ? active : null;
  const latest = useLatestResult(runs);
  const searchMentions = useMentionSearch({
    projectId: session.projectId,
    sessionId: session.sessionId,
    runs,
    team,
  });
  // One command ID per request: a retry after a lost answer reuses it, so the runtime returns
  // the first receipt instead of starting a second run (02-UX-Spec §6).
  const pending = useRef<{ key: string; commandId: string } | null>(null);
  const commandFor = (key: string) => {
    if (pending.current?.key !== key) pending.current = { key, commandId: newCommandId() };
    return pending.current.commandId;
  };
  const [autoStart, setAutoStart] = useRemembered(`corral:auto-queue:${session.sessionId}`, false);

  // What may be sent now: one run at a time, so a busy runtime only takes a queue entry or,
  // for this session's run, an instruction.
  // An instruction needs an execution that can still take one (none while a decision waits).
  const allowed: SessionIntent[] = active
    ? ownActive && targets.length > 0
      ? ['steer', 'queue']
      : ['queue']
    : latest
      ? ['next', 'explain']
      : ['next'];

  // Executions that can still take an instruction, named by their node.
  useEffect(() => {
    void targetTick;
    if (!ownActive) return setTargets([]);
    let live = true;
    void Promise.all([
      transport.getSnapshot(ownActive.runId),
      transport.getRunDefinition(ownActive.runId),
    ]).then(([{ projection }, definition]) => {
      if (!live) return;
      const open = projection.executionOrder
        .map((id) => projection.executions[id])
        .filter((e) => e && !TERMINAL_EXECUTION_STATUSES.has(e.status));
      setTargets(
        open.flatMap((e) =>
          e
            ? [
                {
                  id: e.executionId,
                  label: `${definition?.nodes.find((n) => n.id === e.nodeId)?.label ?? e.nodeId} · #${projection.executionOrder.indexOf(e.executionId) + 1}`,
                },
              ]
            : [],
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [transport, ownActive, targetTick]);
  // An execution may end while the person types: the list follows it (02-UX-Spec §6).
  useEffect(() => {
    if (!ownActive) return;
    const timer = setInterval(() => setTargetTick((n) => n + 1), 1500);
    return () => clearInterval(timer);
  }, [ownActive]);
  for (const x of targets) targetNames.current.set(x.id, x.label);
  const resolved = resolveIntent({
    allowed,
    chosen,
    chosenTarget: target || null,
    lock,
    targets: targets.map((x) => x.id),
    running: Boolean(ownActive),
  });
  const intent = resolved.intent;
  const steerTarget = resolved.target ?? '';
  const targetName = (id: string) => targetNames.current.get(id) ?? id;

  /** Changes the text; the first character fixes what the request is and for whom. */
  const write = (value: string) => {
    setText(value);
    if (!value) setLock(null);
    else if (!lock) setLock({ intent, target: intent === 'steer' ? steerTarget || null : null });
  };
  /** An explicit choice by the person; it becomes the new fixed intent while text is typed. */
  const chooseIntent = (value: SessionIntent) => {
    setChosen(value);
    if (text)
      setLock({
        intent: value,
        target: value === 'steer' ? (lock?.target ?? steerTarget) || targets[0]?.id || null : null,
      });
  };
  const chooseTarget = (value: string) => {
    setTarget(value);
    if (text) setLock({ intent: 'steer', target: value });
  };
  const composerDraft = useMemo(
    () => ({
      text,
      intent: lock?.intent ?? null,
      target: lock?.target ?? null,
      targetLabel: lock?.target ? (targetNames.current.get(lock.target) ?? null) : null,
      references: picked.filter((item) => pickedReferences(text, [item]).length > 0),
    }),
    [text, lock, picked],
  );
  const draftRevision = useRef(0);
  useEffect(() => {
    draftRevision.current = writeComposerDraft(session.sessionId, composerDraft);
  }, [session.sessionId, composerDraft]);
  useEffect(() => {
    const sent = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; revision: number }>).detail;
      if (detail.sessionId !== session.sessionId || detail.revision !== draftRevision.current)
        return;
      setPicked([]);
      setChosen(null);
      setLock(null);
      setText('');
    };
    window.addEventListener(COMPOSER_DRAFT_SENT, sent);
    return () => window.removeEventListener(COMPOSER_DRAFT_SENT, sent);
  }, [session.sessionId]);

  // References restored from a draft are checked once: a result version, run or role that is
  // gone is marked, never swapped for another with the same name (UX-02).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the restored references
  useEffect(() => {
    if (!restored.references.length) return;
    let live = true;
    void (async () => {
      const gone = new Set<string>();
      const roles = team
        ? ((await repository.get(team.corralId))?.definition.roles.map((r) => r.id) ?? [])
        : [];
      for (const item of restored.references) {
        const ref = item.reference;
        try {
          if (ref.kind === 'result') {
            const { projection } = await transport.getSnapshot(ref.runId);
            if (!projection.artifacts[ref.artifactVersionId]) gone.add(item.id);
          } else if (ref.kind === 'run') await transport.getSnapshot(ref.runId);
          else if (ref.kind === 'role' && !roles.includes(ref.roleId)) gone.add(item.id);
        } catch {
          gone.add(item.id);
        }
      }
      if (live) setMissing(gone);
    })();
    return () => {
      live = false;
    };
  }, []);

  // A line range chosen in the file panel arrives as a reference at the caret.
  const used = useRef<FileReference | null>(null);
  useEffect(() => {
    if (!reference || used.current === reference) return;
    used.current = reference;
    const item: MentionItem = {
      id: `file:${reference.path}:${reference.start}-${reference.end}`,
      kind: 'file',
      label: reference.path,
      lines: { start: reference.start, end: reference.end },
      reference: {
        kind: 'file',
        path: reference.path,
        lines: { start: reference.start, end: reference.end },
      },
    };
    setPicked((list) => [...list, item]);
    const box = input.current;
    const at = box?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const token = mentionToken(item);
    const next = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${token} ${text.slice(at)}`;
    write(next);
    onReferenceUsed();
    requestAnimationFrame(() => box?.focus());
  });

  const references = pickedReferences(text, picked);
  const chips = picked.filter(
    (item, index) =>
      picked.findIndex((x) => x.id === item.id) === index &&
      pickedReferences(text, [item]).length > 0,
  );
  const missingChips = chips.filter((item) => missing.has(item.id));

  const record = async (entry: Parameters<typeof repository.addSessionEntry>[1]) => {
    const saved = await repository.addSessionEntry(session.sessionId, entry);
    if (!saved.ok) throw new Error(t('failed', { message: saved.message }));
  };

  /** Starts a follow-up with the team; returns the run or why not. */
  const startNext = async (
    brief: string,
    commandId: string = newCommandId(),
    refs: RunReference[] = [],
    overrides: HarnessOverrides = {},
    roleChoices: RoleRunOverrides = {},
  ): Promise<{ runId: string | null; detail: string | null; code?: string | undefined }> => {
    if (!team) return { runId: null, detail: t('noTeamYet') };
    const corral = await repository.get(team.corralId);
    if (!corral) return { runId: null, detail: t('noTeamYet') };
    const input = { brief, criteria: corral.definition.input.criteria };
    const common = {
      schemaVersion: '0.1' as const,
      commandId,
      mode: runMode,
      sessionId: session.sessionId,
      ...(latest ? { startFrom: { runId: latest.runId, artifactVersionId: latest.id } } : {}),
      ...(refs.length ? { references: refs } : {}),
      ...(Object.keys(overrides).length ? { harnessOverrides: overrides } : {}),
      ...(Object.keys(roleChoices).length ? { roleOverrides: roleChoices } : {}),
    };
    const result = await transport.startRun(
      mode === 'server'
        ? {
            ...common,
            corralId: corral.corralId,
            definitionRevision: corral.definitionRevision,
            input,
          }
        : { ...common, definition: { ...corral.definition, input } },
    );
    return {
      runId: result.runId,
      detail: result.receipt.error?.message ?? null,
      code: result.receipt.error?.code,
    };
  };

  /** A refused request keeps its text, intent and references so it can be fixed and resent. */
  const refused = async (message: string, code?: string) => {
    // A refusal is final for that command; the next attempt is a new command.
    pending.current = null;
    setRefusal({ message, code });
    await router.invalidate();
    onChange();
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    const submittedRevision = writeComposerDraft(session.sessionId, composerDraft);
    draftRevision.current = submittedRevision;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      if (intent === 'next') {
        const refs = references;
        const commandId = commandFor(
          `next\u0000${body}\u0000${JSON.stringify([refs, harnessOverrides, roleOverrides, runMode])}`,
        );
        const { runId, detail, code } = await startNext(
          body,
          commandId,
          refs,
          harnessOverrides,
          roleOverrides,
        );
        if (runId) {
          setRunStyles(null);
          setRoleChoices(null);
        }
        await record({
          intent,
          text: body,
          state: runId ? 'started' : 'refused',
          runId,
          detail,
          commandId,
        });
        if (!runId) return await refused(detail ?? t('noTeamYet'), code);
      } else if (intent === 'queue') {
        await record({ intent, text: body, state: 'queued' });
      } else if (intent === 'steer' && ownActive && steerTarget) {
        const commandId = commandFor(`steer\u0000${steerTarget}\u0000${body}`);
        const receipt = await transport.sendCommand({
          schemaVersion: '0.1',
          commandId,
          runId: ownActive.runId,
          type: 'steer',
          payload: { targetExecutionId: steerTarget, text: body, delivery: 'next_request' },
        });
        await record({
          intent,
          text: body,
          state: receipt.error ? 'refused' : 'sent',
          runId: ownActive.runId,
          executionId: steerTarget,
          detail: receipt.error?.message ?? null,
          commandId,
        });
        if (receipt.error) return await refused(receipt.error.message, receipt.error.code);
      } else if (intent === 'explain') {
        const corral = team ? await repository.get(team.corralId) : null;
        const profile = corral?.definition.roles[0]?.modelProfile ?? 'model-a';
        if (!latest) {
          setError(t('noResult'));
          return;
        }
        const result = await services.startExplain({
          commandId: commandFor(`explain\u0000${body}`),
          sessionId: session.sessionId,
          question: body,
          modelProfile: profile,
          mode: runMode,
          startFrom: { runId: latest.runId, artifactVersionId: latest.id },
        });
        await record({
          intent,
          text: body,
          state: result.runId ? 'started' : 'refused',
          runId: result.runId,
          detail: result.receipt.error?.message ?? null,
        });
        if (!result.runId)
          return await refused(
            result.receipt.error?.message ?? t('noResult'),
            result.receipt.error?.code,
          );
      } else {
        return;
      }
      pending.current = null;
      clearSentComposerDraft(session.sessionId, submittedRevision);
      await router.invalidate();
      onChange();
    } catch (failure) {
      // The answer was lost: the request may or may not have arrived. The text stays, and a
      // retry reuses the same command ID, so the runtime returns the first receipt (UX-04).
      setRefusal({
        message: failure instanceof Error ? failure.message : String(failure),
        network: true,
      });
    } finally {
      setBusy(false);
    }
  };

  // "Edit the request again" on a refused turn brings its text back here.
  useEffect(() => {
    const take = (event: Event) => {
      const value = (event as CustomEvent<string>).detail;
      if (typeof value !== 'string') return;
      setText(value);
      setLock(null);
      setRefusal(null);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(EDIT_REQUEST, take);
    return () => window.removeEventListener(EDIT_REQUEST, take);
  }, []);

  const runCommand = async (type: 'pause' | 'resume' | 'cancel') => {
    if (!ownActive) return;
    const receipt = await transport
      .sendCommand(
        type === 'cancel'
          ? {
              schemaVersion: '0.1',
              commandId: newCommandId(),
              runId: ownActive.runId,
              type,
              payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
            }
          : {
              schemaVersion: '0.1',
              commandId: newCommandId(),
              runId: ownActive.runId,
              type,
              payload: { scope: 'run' },
            },
      )
      .catch((failure: unknown) => ({
        error: { message: failure instanceof Error ? failure.message : String(failure) },
      }));
    if (receipt.error) setError(receipt.error.message);
    onChange();
  };

  const startQueued = async (entry: SessionEntry) => {
    setBusy(true);
    try {
      const { runId, detail } = await startNext(entry.text);
      await repository.updateSessionEntry(session.sessionId, entry.entryId, {
        state: runId ? 'started' : 'refused',
        runId,
        detail,
      });
      await router.invalidate();
      onChange();
    } finally {
      setBusy(false);
    }
  };
  const removeQueued = async (entry: SessionEntry) => {
    await repository.updateSessionEntry(session.sessionId, entry.entryId, { state: 'dismissed' });
    await router.invalidate();
  };
  /** Editing a queued task takes it back into the box; sending again records a new version. */
  const editQueued = async (entry: SessionEntry) => {
    setText(entry.text);
    setChosen('queue');
    setLock({ intent: 'queue', target: null });
    await repository.updateSessionEntry(session.sessionId, entry.entryId, {
      state: 'dismissed',
      detail: 'edited',
    });
    await router.invalidate();
  };

  // Auto-start, when switched on: only on a run's end seen by this page, never on load.
  const wasActive = useRef(Boolean(ownActive));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the run ending only
  useEffect(() => {
    const ended = wasActive.current && !active;
    wasActive.current = Boolean(ownActive);
    const next = queued[0];
    if (ended && autoStart && next && team) void startQueued(next);
  }, [active, ownActive]);

  const updateTeam = async (corralId: string) => {
    const result = await repository.updateSession(session.sessionId, {
      corralId: corralId || null,
      expectedRevision: session.revision,
    });
    if (!result.ok) setError(t('failed', { message: result.message }));
    else await router.invalidate();
  };

  // Earlier requests, newest first, for ↑ in an empty box.
  const history = session.entries
    .map((e) => e.text)
    .filter((value, index, all) => value.trim() && all.lastIndexOf(value) === index)
    .reverse();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME composition's Enter confirms the text; it never sends (WB-UX-005).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (isSendKey(event, prefs.sendKey)) {
      event.preventDefault();
      void send();
      return;
    }
    const box = event.currentTarget;
    const recalled = recall >= 0 && text === history[recall];
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.shiftKey &&
      (text === '' || recalled) &&
      box.selectionStart === box.selectionEnd
    ) {
      const next = event.key === 'ArrowUp' ? recall + 1 : recall - 1;
      if (next < -1 || next >= history.length) return;
      event.preventDefault();
      setRecall(next);
      write(next === -1 ? '' : (history[next] ?? ''));
    }
  };

  // UX-04: with live models chosen, a role whose model is not connected stops the request
  // before it is sent, with the way to connect it.
  const notReady =
    runMode === 'live' && (intent === 'next' || intent === 'explain') && profiles
      ? roles.filter(
          (r) =>
            !profiles.some(
              (p) =>
                p.profileId === (roleOverrides[r.roleId]?.modelProfile ?? r.profileId) &&
                p.available,
            ),
        )
      : [];
  const liveUnavailable =
    runMode === 'live' && !live && (intent === 'next' || intent === 'explain');
  const unavailable =
    liveUnavailable ||
    notReady.length > 0 ||
    resolved.blocked !== null ||
    missingChips.length > 0 ||
    (intent === 'next' && !team) ||
    (intent === 'explain' && !latest) ||
    (intent === 'steer' && !steerTarget);
  const stopping = Boolean(ownActive) && !text.trim();
  const canLive = mode === 'server' && live && (intent === 'next' || intent === 'explain');
  const why = (allowedHere: boolean) => (allowedHere ? undefined : tc('notNow'));

  useRegisterCommands('composer', [
    ...(['next', 'queue', 'steer', 'explain'] as SessionIntent[]).map(
      (value): AppCommand => ({
        id: `intent:${value}`,
        title: t(`intent.${value}`),
        group: tc('groupRequest'),
        slash: value === 'explain' ? 'ask' : value,
        keywords: [t(`intentShort.${value}`)],
        disabled: !allowed.includes(value),
        ...(allowed.includes(value) ? {} : { hint: tc('notNow') }),
        run: () => {
          chooseIntent(value);
          input.current?.focus();
        },
      }),
    ),
    {
      id: 'run:pause',
      title: tr('pause'),
      group: tc('groupRun'),
      slash: 'pause',
      disabled: ownActive?.status !== 'running',
      hint: why(ownActive?.status === 'running'),
      run: () => void runCommand('pause'),
    },
    {
      id: 'run:resume',
      title: tr('resume'),
      group: tc('groupRun'),
      slash: 'resume',
      disabled: ownActive?.status !== 'paused',
      hint: why(ownActive?.status === 'paused'),
      run: () => void runCommand('resume'),
    },
    {
      id: 'run:stop',
      title: tr('cancelRun'),
      group: tc('groupRun'),
      slash: 'stop',
      shortcutId: 'run.stop',
      shortcut: shortcutLabel('run.stop'),
      disabled: !ownActive,
      hint: why(Boolean(ownActive)),
      run: () => setConfirmStop(true),
    },
    {
      id: 'composer:team',
      title: t('chooseTeam'),
      group: tc('groupRequest'),
      slash: 'team',
      keywords: corrals.map((c) => c.name),
      run: () => setTeamOpen(true),
    },
    ...(mode === 'server' && live
      ? [
          {
            id: 'composer:mode',
            title: t('mode'),
            group: tc('groupRequest'),
            slash: 'mode',
            keywords: [t('modeMock'), t('modeLive')],
            run: () => setModeOpen(true),
          },
        ]
      : []),
    {
      id: 'composer:models',
      title: tc('models.title'),
      group: tc('groupRequest'),
      slash: 'model',
      run: () => setModelsOpen(true),
    },
    {
      id: 'composer:focus',
      title: tc('focus'),
      group: tc('groupRequest'),
      shortcutId: 'composer.focus',
      shortcut: shortcutLabel('composer.focus'),
      run: () => input.current?.focus(),
    },
  ]);
  const commands = useRegisteredCommands();

  return (
    <ComposerSurface.Shell>
      {queued.length > 0 ? (
        <section
          aria-label={t('queueHeading')}
          className="mx-3 rounded-t-xl border border-b-0 border-line bg-surface px-3 py-2"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted">
              {t('queueHeading')} · {queued.length}
            </h3>
            <label
              className="flex items-center gap-1.5 text-2xs text-muted"
              title={t('autoStartHint')}
            >
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
              />
              {t('autoStart')}
            </label>
          </div>
          <ul className="mt-1 flex flex-col">
            {queued.map((entry) => (
              <li key={entry.entryId} className="group/queued flex items-center gap-1 text-ui">
                <span className="min-w-0 flex-1 truncate" title={entry.text}>
                  {entry.text}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={Boolean(active) || busy || !team}
                  onClick={() => void startQueued(entry)}
                >
                  {t('startNow')}
                </Button>
                <Button variant="ghost-muted" size="xs" onClick={() => void editQueued(entry)}>
                  {t('editQueued')}
                </Button>
                <Button variant="ghost-muted" size="xs" onClick={() => void removeQueued(entry)}>
                  {t('remove')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {intent === 'next' ? (
        <>
          <RunRoleOverrides
            roles={roles}
            profiles={profiles}
            value={roleOverrides}
            onChange={(value) => setRoleChoices({ key: harnessKey, value })}
          />
          <RunHarnessOverrides
            roles={roles}
            projectId={session.projectId}
            value={harnessOverrides}
            onChange={(value) => setRunStyles({ key: harnessKey, value })}
            disabled={busy}
          />
        </>
      ) : null}
      <ComposerSurface.Host>
        <section aria-label={t('requestLabel')} className="flex flex-col gap-1 px-3 pt-2.5 pb-2">
          {active && !ownActive ? (
            <p role="note" className="text-xs text-warning">
              {t('busyElsewhere', { runId: active.runId })}
            </p>
          ) : null}
          {resolved.blocked ? (
            <div
              role="alert"
              data-testid="intent-blocked"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning"
            >
              <span className="min-w-0 flex-1">
                {resolved.blocked === 'target'
                  ? tc('blocked.target', { name: targetName(steerTarget) })
                  : resolved.blocked === 'run'
                    ? tc('blocked.run')
                    : tc('blocked.intent', { intent: t(`intentShort.${intent}`) })}
              </span>
              {allowed
                .filter((value) => value !== intent)
                .map((value) => (
                  <Button
                    key={value}
                    variant="outline"
                    size="xs"
                    onClick={() => chooseIntent(value)}
                  >
                    {tc(`switchTo.${value}`)}
                  </Button>
                ))}
            </div>
          ) : null}
          {notReady.length ? (
            <div
              role="alert"
              data-testid="models-not-ready"
              className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning"
            >
              <span className="min-w-0 flex-1">
                {tc('models.notReady', {
                  roles: notReady.map((r) => `${r.name} (${r.profileId})`).join(', '),
                })}
              </span>
              <Button size="xs" render={<Link to="/settings/models" search={navigation.search} />}>
                {tc('models.connect')}
              </Button>
              <Button variant="outline" size="xs" onClick={() => setRunMode('mock')}>
                {tc('models.useSimulated')}
              </Button>
            </div>
          ) : null}
          {refusal ? (
            <RefusalHelp
              message={refusal.message}
              code={refusal.code}
              network={refusal.network}
              onRetry={() => void send()}
              onQueue={() => {
                setRefusal(null);
                chooseIntent('queue');
              }}
            />
          ) : null}
          {missingChips.length ? (
            <p role="alert" className="text-xs text-danger">
              {tc('missingReferences', { count: missingChips.length })}
            </p>
          ) : null}
          {chips.length && intent !== 'next' ? (
            <p className="text-2xs text-muted">{tc('referencesNextOnly')}</p>
          ) : null}
          {chips.length ? (
            <ul aria-label={tc('references')} className="flex flex-wrap gap-1">
              {chips.map((item) => (
                <li
                  key={item.id}
                  data-missing={missing.has(item.id) || undefined}
                  className={`flex max-w-full items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 text-xs ${missing.has(item.id) ? 'bg-danger/10 text-danger line-through' : 'bg-subtle'}`}
                >
                  <span className="truncate font-mono" title={item.label}>
                    {mentionToken(item).slice(1)}
                  </span>
                  {missing.has(item.id) ? (
                    <span className="sr-only">{tc('referenceGone')}</span>
                  ) : null}
                  <Button
                    variant="ghost-muted"
                    size="icon-tiny"
                    aria-label={tc('removeReference', { label: item.label })}
                    onClick={() => {
                      write(text.split(mentionToken(item)).join('').replace(/ {2,}/g, ' '));
                      setPicked((list) => list.filter((x) => x.id !== item.id));
                    }}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <ComposerInput
            inputRef={input}
            label={t('requestLabel')}
            placeholder={tc('placeholder')}
            value={text}
            onChange={(value) => {
              setRecall(-1);
              write(value);
            }}
            onKeyDown={onKeyDown}
            commands={commands}
            searchMentions={searchMentions}
            onMention={(item) => setPicked((list) => [...list, item])}
          />
          <div className="flex flex-wrap items-center gap-0.5">
            <Tooltip content={tc('addReference')}>
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={tc('addReference')}
                onClick={() => {
                  const box = input.current;
                  const at = box?.selectionStart ?? text.length;
                  const before = text.slice(0, at);
                  const head = `${before}${before && !/\s$/.test(before) ? ' ' : ''}@`;
                  write(`${head}${text.slice(at)}`);
                  requestAnimationFrame(() => {
                    box?.focus();
                    box?.setSelectionRange(head.length, head.length);
                  });
                }}
              >
                <AtSign />
              </Button>
            </Tooltip>
            {allowed.length > 1 && !resolved.blocked ? (
              <Select
                variant="chip"
                label={t('intentLabel')}
                value={intent}
                onValueChange={chooseIntent}
                options={allowed.map((value) => ({
                  value,
                  label: t(`intentShort.${value}`),
                  hint: t(`intentHint.${value}`),
                }))}
              />
            ) : intent !== 'next' || resolved.blocked ? (
              <span className="px-2 text-ui text-muted">{t(`intentShort.${intent}`)}</span>
            ) : null}
            {intent === 'steer' ? (
              <Select
                variant="chip"
                label={t('target')}
                value={steerTarget || null}
                placeholder={t('noTarget')}
                onValueChange={chooseTarget}
                options={[
                  ...(steerTarget && !targets.some((x) => x.id === steerTarget)
                    ? [
                        {
                          value: steerTarget,
                          label: tc('ended', { name: targetName(steerTarget) }),
                          disabled: true,
                        },
                      ]
                    : []),
                  ...targets.map((x) => ({ value: x.id, label: x.label })),
                ]}
                disabled={targets.length === 0}
              />
            ) : null}
            {intent === 'next' || intent === 'explain' ? (
              <Select
                variant="chip"
                label={t('teamLabel')}
                value={team?.corralId ?? ''}
                open={teamOpen}
                onOpenChange={setTeamOpen}
                onValueChange={(value) => void updateTeam(value)}
                options={[
                  { value: '', label: t('noTeam') },
                  ...corrals.map((c) => ({ value: c.corralId, label: c.name })),
                ]}
              />
            ) : null}
            {canLive || runMode === 'live' ? (
              <Select
                variant="chip"
                label={t('mode')}
                value={runMode}
                open={modeOpen}
                onOpenChange={setModeOpen}
                onValueChange={setRunMode}
                options={[
                  { value: 'mock', label: t('modeMock') },
                  { value: 'live', label: t('modeLive') },
                ]}
              />
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              {stopping ? (
                <Tooltip content={tr('cancelRun')} shortcut={shortcutLabel('run.stop')}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={tr('cancelRun')}
                    className="rounded-full"
                    onClick={() => setConfirmStop(true)}
                  >
                    <Square className="fill-current" />
                  </Button>
                </Tooltip>
              ) : (
                <Tooltip content={t('send')} shortcut={sendKeyLabel(prefs.sendKey)}>
                  <Button
                    size="icon-sm"
                    aria-label={t('send')}
                    disabled={busy || !text.trim() || unavailable}
                    className="rounded-full"
                    onClick={() => void send()}
                  >
                    <ArrowUp />
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
        </section>
      </ComposerSurface.Host>
      <div className="flex min-h-5 flex-wrap items-center gap-x-2 px-4 pt-1.5 text-2xs text-muted">
        {intent === 'next' && !team ? <span className="text-warning">{t('noTeamYet')}</span> : null}
        {intent === 'explain' && !latest ? (
          <span className="text-warning">{t('noResult')}</span>
        ) : null}
        {modeChoice.error ? <p role="alert">{tc('modeSaveFailed')}</p> : null}
        {liveUnavailable ? <p role="alert">{tc('liveUnavailable')}</p> : null}
        {(intent === 'next' || intent === 'explain') && team ? (
          <PreRunSummary session={session} team={team} mode={runMode} intent={intent} />
        ) : null}
        {(intent === 'next' || intent === 'explain') && latest ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('fromResult', { label: latest.label })}</span>
          </>
        ) : null}
        {intent === 'steer' ? <span>{t('intentHint.steer')}</span> : null}
        {intent === 'queue' ? <span>{t('intentHint.queue')}</span> : null}
      </div>
      {error ? (
        <p role="alert" className="px-4 pt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <Dialog open={modelsOpen} onOpenChange={setModelsOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tc('models.title')}</DialogTitle>
            <DialogDescription>
              {runMode === 'live' ? tc('models.liveNote') : tc('models.mockNote')}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ModelAssignments roles={roles} profiles={profiles} />
          </DialogPanel>
          <DialogFooter>
            {team ? (
              <Button
                variant="outline"
                render={
                  <Link
                    to="/corrals/$corralId/edit"
                    params={{ corralId: team.corralId }}
                    search={{ fromSession: session.sessionId }}
                  />
                }
              >
                {t('editTeam')}
              </Button>
            ) : null}
            {mode === 'server' ? (
              <Button render={<Link to="/settings/models" search={navigation.search} />}>
                {tc('models.settings')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr('cancelRun')}</DialogTitle>
            <DialogDescription>{tr('cancelRunExplain')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmStop(false)}>
              {tr('keepRunning')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmStop(false);
                void runCommand('cancel');
              }}
            >
              {tr('confirmCancelRun')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </ComposerSurface.Shell>
  );
}

/** The newest final result among the session's ended runs. */
function useLatestResult(runs: RunSummary[]) {
  const { transport } = useServices();
  const [latest, setLatest] = useState<{ runId: string; id: string; label: string } | null>(null);
  // Newest first; a joined key so the lookup reruns only when the ended runs change.
  const key = runs
    .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
    .map((r) => r.runId)
    .reverse()
    .join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const runId of key ? key.split(',') : []) {
        const { projection } = await transport.getSnapshot(runId);
        const id = finalResultId(projection);
        const artifact = id ? projection.artifacts[id] : undefined;
        if (id && artifact) {
          if (live) setLatest({ runId, id, label: `${artifact.name} v${artifact.version}` });
          return;
        }
      }
      if (live) setLatest(null);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [transport, key]);
  return latest;
}

/**
 * What the next run would start with (02-UX-Spec §5.5): team, models, file work, limits and
 * mode, read from the saved team and the working copy, never guessed.
 */
function PreRunSummary({
  session,
  team,
  mode,
  intent,
}: {
  session: WorkSession;
  team: CorralSummary;
  mode: 'mock' | 'live';
  intent: 'next' | 'explain';
}) {
  const t = useTranslations('Sessions');
  const { repository, workspaces } = useServices();
  const [text, setText] = useState<string | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  useEffect(() => {
    const changed = () => setWorkspaceRevision((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  // A new team revision changes what the next run would use.
  const revision = team.definitionRevision;
  useEffect(() => {
    void revision;
    void workspaceRevision;
    let live = true;
    void (async () => {
      const record = await repository.get(team.corralId);
      if (!record) return;
      const copy = workspaces
        ? await workspaces.worktree(session.sessionId).catch(() => null)
        : null;
      const roles =
        intent === 'explain' ? record.definition.roles.slice(0, 1) : record.definition.roles;
      const fileTools =
        intent === 'next' && roles.some((r) => r.allowedWorkTools.includes('write_file'));
      const limits = record.definition.limits;
      if (!live) return;
      setText(
        t('preRun', {
          team: `${record.name} r${record.definitionRevision}`,
          profiles: [...new Set(roles.map((r) => r.modelProfile))].join(', '),
          files: fileTools ? (copy ? t('filesCopy') : t('filesNoCopy')) : t('filesNone'),
          calls: intent === 'explain' ? Math.min(limits.maxModelCalls, 4) : limits.maxModelCalls,
          minutes: Math.round(limits.runDeadlineMs / 60_000),
          mode: mode === 'live' ? t('modeLive') : t('modeMock'),
        }),
      );
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [
    repository,
    workspaces,
    session.sessionId,
    team.corralId,
    revision,
    workspaceRevision,
    mode,
    intent,
    t,
  ]);
  return text ? <span data-testid="pre-run">{text}</span> : null;
}

/** Each role of the team, the model profile it uses, and whether that model is ready (UX-06). */
function ModelAssignments({
  roles,
  profiles,
}: {
  roles: RoleModel[];
  profiles: ProfileInfo[] | null;
}) {
  const tc = useTranslations('Composer');
  if (!roles.length) return <p className="text-sm text-muted">{tc('models.noTeam')}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line/60 text-sm" data-testid="model-assignments">
      {roles.map((role) => {
        const profile = profiles?.find((p) => p.profileId === role.profileId);
        const state = !profiles
          ? 'simulated'
          : !profile
            ? 'missing'
            : profile.available
              ? 'ready'
              : 'signin';
        return (
          <li key={role.roleId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
            <span className="font-medium">{role.name}</span>
            <span className="font-mono text-xs text-muted">{role.profileId}</span>
            <span className="min-w-0 flex-1 text-xs text-muted">{profile?.label ?? ''}</span>
            <span
              className={`text-xs ${state === 'ready' ? 'text-success' : state === 'simulated' ? 'text-muted' : 'text-warning'}`}
            >
              {tc(`models.state.${state}`)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
