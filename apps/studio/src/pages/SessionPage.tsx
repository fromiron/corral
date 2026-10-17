import type { FileChangeView } from '@corral/client';
import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type {
  CorralSummary,
  RunProjection,
  RunSummary,
  SessionEntry,
  SessionIntent,
  WorkSession,
} from '@corral/core';
import { ApprovalPanel, SafeMarkdown, StatusBadge } from '@corral/react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { setCurrentProject } from '../projects.ts';
import { type SessionSearch, sessionRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { TeamDesign } from './EditorPage.tsx';
import { useBinding, WorkingCopyPanel } from './FilesViews.tsx';
import { Checks } from './ReviewPage.tsx';
import { RunDetail } from './RunPage.tsx';
import { useRemembered, WorkbenchLayout, WorkbenchSidebar } from './Workbench.tsx';

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

export type SessionTab = 'work' | 'team' | 'run';
export type SessionPanel = 'changes' | 'artifacts' | 'checks';

/**
 * A session as a workbench (02-UX-Spec §2–§3): the sidebar, a header with what is true now,
 * Work / Team design / Run detail in the middle, and Changes / Results / Checks on the right.
 * Tabs and choices live in the address, so they survive reloads and the back button.
 */
export function SessionPage() {
  const tw = useTranslations('Workbench');
  const { session, project, corrals } = sessionRoute.useLoaderData();
  const search = sessionRoute.useSearch();
  const navigate = useNavigate({ from: '/sessions/$sessionId' });
  const { runs, active, refresh, lost } = useSessionRuns(session.sessionId);
  useEffect(() => setCurrentProject(session.projectId), [session.projectId]);
  const team = corrals.find((c) => c.corralId === session.corralId) ?? null;
  const ts = useTranslations('Sessions');
  const tab: SessionTab = search.tab ?? 'work';
  const panel: SessionPanel = search.panel ?? 'changes';
  const setSearch = (patch: Partial<typeof search>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }) });
  const tabs: SessionTab[] = ['work', 'team', 'run'];

  return (
    <WorkbenchLayout
      sidebar={
        <WorkbenchSidebar projectId={session.projectId} activeSessionId={session.sessionId} />
      }
      main={
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkbenchHeader
            session={session}
            projectLabel={project ? project.name : ''}
            team={team}
            active={active && active.sessionId === session.sessionId ? active : null}
          />
          {lost ? (
            <div
              role="alert"
              className="flex items-center gap-2 border-b border-danger px-4 py-2 text-xs text-danger"
            >
              {ts('connectionLost')}
              <button
                type="button"
                onClick={refresh}
                className="rounded border border-line px-2 py-0.5 text-text"
              >
                {ts('retry')}
              </button>
            </div>
          ) : null}
          <TabRow
            label={tw('tabs')}
            values={tabs}
            current={tab}
            text={(value) => tw(`tab.${value}`)}
            onChoose={(value) => setSearch({ tab: value })}
          />
          <div
            role="tabpanel"
            aria-label={tw(`tab.${tab}`)}
            className="flex min-h-0 flex-1 flex-col overflow-auto"
          >
            {tab === 'work' ? (
              <WorkTab
                session={session}
                corrals={corrals}
                team={team}
                runs={runs}
                active={active}
                onChange={refresh}
              />
            ) : tab === 'team' ? (
              team ? (
                <TeamDesign corralId={team.corralId} />
              ) : (
                <p className="p-4 text-sm text-muted">{tw('noTeam')}</p>
              )
            ) : (
              <RunTab runs={runs} search={search} setSearch={setSearch} />
            )}
          </div>
        </div>
      }
      panel={
        <div className="flex min-h-0 flex-col">
          <TabRow
            label={tw('panelTabs')}
            values={['changes', 'artifacts', 'checks'] as SessionPanel[]}
            current={panel}
            text={(value) => tw(`panel.${value}`)}
            onChoose={(value) => setSearch({ panel: value })}
          />
          <div
            role="tabpanel"
            aria-label={tw(`panel.${panel}`)}
            className="flex flex-col gap-3 p-3"
          >
            {panel === 'changes' ? (
              <ChangesPanel session={session} runs={runs} />
            ) : panel === 'artifacts' ? (
              <ArtifactsPanel
                runs={runs}
                onOpen={(runId, result) =>
                  setSearch({ tab: 'run', run: runId, view: 'results', result })
                }
              />
            ) : (
              <ChecksPanel session={session} />
            )}
          </div>
        </div>
      }
    />
  );
}

/** A WAI-ARIA tab row; arrow keys move between tabs. */
function TabRow<T extends string>({
  label,
  values,
  current,
  text,
  onChoose,
}: {
  label: string;
  values: T[];
  current: T;
  text: (value: T) => string;
  onChoose: (value: T) => void;
}) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = values[(index + step + values.length) % values.length] as T;
    onChoose(next);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line px-3 pt-2">
      {values.map((value, index) => (
        <button
          key={value}
          ref={(el) => {
            refs.current[value] = el;
          }}
          type="button"
          role="tab"
          aria-selected={current === value}
          tabIndex={current === value ? 0 : -1}
          onClick={() => onChoose(value)}
          onKeyDown={(event) => move(event, index)}
          className={`rounded-t px-3 py-1 text-xs ${
            current === value ? 'border border-b-0 border-line bg-raised font-medium' : 'text-muted'
          }`}
        >
          {text(value)}
        </button>
      ))}
    </div>
  );
}

/** What is true now: project, session, team revision, working copy, run state, runtime mode. */
function WorkbenchHeader({
  session,
  projectLabel,
  team,
  active,
}: {
  session: WorkSession;
  projectLabel: string;
  team: CorralSummary | null;
  active: RunSummary | null;
}) {
  const tw = useTranslations('Workbench');
  const tp = useTranslations('Projects');
  const tf = useTranslations('Files');
  const { workspaces, mode, live } = useServices();
  const { binding } = useBinding(session.projectId);
  const [copy, setCopy] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaces) return;
    void workspaces.worktree(session.sessionId).then(
      (w) => setCopy(w ? w.baseCommit.slice(0, 8) : null),
      () => setCopy(null),
    );
  }, [workspaces, session.sessionId]);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2 text-xs">
      <p className="text-sm">
        <Link
          to="/projects/$projectId"
          params={{ projectId: session.projectId }}
          className="text-muted underline-offset-4 hover:underline"
        >
          {projectLabel || tp('defaultName')}
        </Link>
        <span className="text-muted"> / </span>
        <span className="font-semibold">{session.title}</span>
      </p>
      <span>
        {team
          ? tw('headerTeam', { name: team.name, revision: team.definitionRevision })
          : tw('noTeamHeader')}
      </span>
      {workspaces ? <span>{copy ? tw('copyFrom', { commit: copy }) : tw('copyNone')}</span> : null}
      <span data-testid="permission">
        {tf(`permission.${copy ? 'copy' : binding ? 'observe' : 'none'}`)}
      </span>
      <span aria-live="polite">
        {active ? (
          <StatusBadge status={active.status} />
        ) : (
          <span className="text-muted">{tw('idle')}</span>
        )}
      </span>
      <span className="ml-auto rounded-full border border-warning px-2 py-0.5 text-warning">
        {tw(`mode.${mode}`)} · {live ? tw('live') : tw('simulated')}
      </span>
    </div>
  );
}

/** The Work tab: what was asked, the runs it started, decisions waiting, and the input box. */
function WorkTab({
  session,
  corrals,
  team,
  runs,
  active,
  onChange,
}: {
  session: WorkSession;
  corrals: CorralSummary[];
  team: CorralSummary | null;
  runs: RunSummary[];
  active: RunSummary | null;
  onChange: () => void;
}) {
  const t = useTranslations('Sessions');
  // Entries in order; runs that no entry names (started elsewhere) are shown after them.
  const named = new Set(session.entries.flatMap((e) => (e.runId ? [e.runId] : [])));
  const loose = runs.filter((r) => !named.has(r.runId));
  const queued = session.entries.filter((e) => e.state === 'queued');
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
      <SessionHeader session={session} corrals={corrals} team={team} />
      <section aria-label={t('heading')} className="flex flex-col gap-3">
        {session.entries.length === 0 && loose.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-muted">
            {t('timelineEmpty')}
          </p>
        ) : null}
        {session.entries
          .filter((e) => e.state !== 'queued' && e.state !== 'dismissed')
          .map((entry) => (
            <EntryCard key={entry.entryId} entry={entry} runs={runs} />
          ))}
        {loose.map((run) => (
          <RunCard key={run.runId} run={run} />
        ))}
      </section>
      {active && active.sessionId === session.sessionId ? (
        <ActiveDecisions runId={active.runId} />
      ) : null}
      <Composer
        session={session}
        team={team}
        runs={runs}
        active={active}
        queued={queued}
        onChange={onChange}
      />
    </div>
  );
}

/** Run detail inside the workbench: the chosen run (newest by default) with its own views. */
function RunTab({
  runs,
  search,
  setSearch,
}: {
  runs: RunSummary[];
  search: SessionSearch;
  setSearch: (patch: Partial<SessionSearch>) => void;
}) {
  const tw = useTranslations('Workbench');
  const runId =
    search.run && runs.some((r) => r.runId === search.run) ? search.run : runs.at(-1)?.runId;
  if (!runId) return <p className="p-4 text-sm text-muted">{tw('noRuns')}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label className="flex items-center gap-2 border-b border-line px-4 py-1 text-xs">
        {tw('chooseRun')}
        <select
          value={runId}
          onChange={(e) =>
            setSearch({
              run: e.target.value,
              execution: undefined,
              artifact: undefined,
              view: undefined,
              result: undefined,
            })
          }
          className="rounded border border-line bg-surface px-1 py-0.5"
        >
          {[...runs].reverse().map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.runId} · {r.status}
            </option>
          ))}
        </select>
      </label>
      <div className="min-h-0 flex-1">
        <RunDetail
          key={runId}
          runId={runId}
          embedded
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
function ChangesPanel({ session, runs }: { session: WorkSession; runs: RunSummary[] }) {
  const tw = useTranslations('Workbench');
  const tf = useTranslations('Files');
  const { workspaces } = useServices();
  const [files, setFiles] = useState<FileChangeView[] | null>(null);
  // Refresh when a run of the session starts or ends.
  const key = runs.map((r) => `${r.runId}:${r.status}`).join(',');
  useEffect(() => {
    void key;
    if (!workspaces) return;
    let live = true;
    // Without a working copy there is nothing to compare; asking would only be refused.
    void (async () => {
      const copy = await workspaces.worktree(session.sessionId).catch(() => null);
      if (!copy || copy.missing) return live && setFiles(null);
      const changes = await workspaces.changes(session.sessionId, { kind: 'session' });
      if (live) setFiles(changes.files);
    })().catch(() => live && setFiles(null));
    return () => {
      live = false;
    };
  }, [workspaces, session.sessionId, key]);
  if (!workspaces) return <p className="text-xs text-muted">{tw('serverOnly')}</p>;
  return (
    <>
      <WorkingCopyPanel sessionId={session.sessionId} projectId={session.projectId} />
      {files === null ? (
        <p className="text-xs text-muted">{tw('noCopyChanges')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">{tw('changeCount', { count: files.length })}</p>
          <ul className="flex flex-col gap-0.5 text-xs">
            {files.slice(0, 50).map((f) => (
              <li key={f.path}>
                <Link
                  to="/sessions/$sessionId/review"
                  params={{ sessionId: session.sessionId }}
                  search={{ file: f.path }}
                  className="break-all font-mono underline-offset-2 hover:underline"
                >
                  {f.path}
                </Link>{' '}
                <span className="text-muted">
                  {tf(`status.${f.status}`)}
                  {f.additions !== null ? ` +${f.additions} −${f.deletions ?? 0}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <Link
            to="/sessions/$sessionId/review"
            params={{ sessionId: session.sessionId }}
            className="self-start rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent"
          >
            {tw('expandReview')}
          </Link>
        </div>
      )}
    </>
  );
}

/** Results: final results of the session's ended runs, newest first, opened in Run detail. */
function ArtifactsPanel({
  runs,
  onOpen,
}: {
  runs: RunSummary[];
  onOpen: (runId: string, artifactVersionId: string) => void;
}) {
  const tw = useTranslations('Workbench');
  const { transport } = useServices();
  const [items, setItems] = useState<{ runId: string; id: string; label: string }[]>([]);
  // Ended runs, newest first, as one key: the lookup reruns only when they change.
  const key = [...runs]
    .reverse()
    .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
    .slice(0, 10)
    .map((r) => r.runId)
    .join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      const found: { runId: string; id: string; label: string }[] = [];
      for (const runId of key ? key.split(',') : []) {
        const { projection } = await transport.getSnapshot(runId);
        for (const id of projection.output?.artifactVersionIds ?? []) {
          const a = projection.artifacts[id];
          if (a) found.push({ runId, id, label: `${a.name} v${a.version}` });
        }
      }
      if (live) setItems(found);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [transport, key]);
  if (items.length === 0) return <p className="text-xs text-muted">{tw('artifactsEmpty')}</p>;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {items.map((item) => (
        <li key={`${item.runId}:${item.id}`}>
          <button
            type="button"
            onClick={() => onOpen(item.runId, item.id)}
            className="flex w-full flex-col rounded border border-line px-2 py-1 text-left"
          >
            <span className="font-medium">{item.label}</span>
            <span className="font-mono text-xs text-muted">{item.runId}</span>
          </button>
        </li>
      ))}
    </ul>
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
      <Link
        to="/sessions/$sessionId/review"
        params={{ sessionId: session.sessionId }}
        className="text-xs underline"
      >
        {tw('expandReview')}
      </Link>
    </>
  );
}

/** Decisions the session's working run waits for, answered here (WB-OBS-002). */
function ActiveDecisions({ runId }: { runId: string }) {
  const { session } = useServices();
  const navigate = useNavigate();
  useEffect(() => {
    void session.getState().open(runId);
  }, [session, runId]);
  return (
    <ApprovalPanel
      session={session}
      onOpenArtifact={(id) =>
        void navigate({
          to: '/runs/$runId',
          params: { runId },
          search: { view: 'results', result: id },
        })
      }
    />
  );
}

function SessionHeader({
  session,
  corrals,
  team,
}: {
  session: WorkSession;
  corrals: CorralSummary[];
  team: CorralSummary | null;
}) {
  const t = useTranslations('Sessions');
  const { repository } = useServices();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const update = async (change: {
    corralId?: string | null;
    pinned?: boolean;
    archived?: boolean;
  }) => {
    const result = await repository.updateSession(session.sessionId, {
      ...change,
      expectedRevision: session.revision,
    });
    if (!result.ok) return setError(t('failed', { message: result.message }));
    setError(null);
    await router.invalidate();
  };
  return (
    <header className="flex flex-col gap-2 border-b border-line pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{session.title}</h2>
        {session.pinned ? (
          <span className="rounded-full border border-line px-2 py-0.5 text-xs">{t('pinned')}</span>
        ) : null}
        {session.archivedAt ? (
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
            {t('archived')}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void update({ pinned: !session.pinned })}
          className="rounded border border-line px-2 py-0.5 text-xs"
        >
          {session.pinned ? t('unpin') : t('pin')}
        </button>
        <button
          type="button"
          onClick={() => void update({ archived: !session.archivedAt })}
          className="rounded border border-line px-2 py-0.5 text-xs"
        >
          {session.archivedAt ? t('restore') : t('archive')}
        </button>
      </div>
      {session.objective ? (
        <p className="whitespace-pre-wrap text-sm text-muted">
          <span className="font-medium text-text">{t('purpose')}: </span>
          {session.objective}
        </p>
      ) : null}
      <label className="flex flex-wrap items-center gap-2 text-sm">
        {t('chooseTeam')}
        <select
          value={team?.corralId ?? ''}
          onChange={(e) => void update({ corralId: e.target.value || null })}
          className="rounded border border-line bg-surface px-2 py-1"
        >
          <option value="">{t('noTeam')}</option>
          {corrals.map((c) => (
            <option key={c.corralId} value={c.corralId}>
              {c.name}
            </option>
          ))}
        </select>
        {team ? (
          <Link
            to="/corrals/$corralId/edit"
            params={{ corralId: team.corralId }}
            className="text-xs underline"
          >
            {team.name}
          </Link>
        ) : null}
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </header>
  );
}

function EntryCard({ entry, runs }: { entry: SessionEntry; runs: RunSummary[] }) {
  const t = useTranslations('Sessions');
  const format = useFormatter();
  const run = entry.runId ? runs.find((r) => r.runId === entry.runId) : undefined;
  return (
    <article
      data-testid={`entry-${entry.entryId}`}
      className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{t('youAsked', { intent: t(`intent.${entry.intent}`) })}</span>
        <span>
          {t(`state.${entry.state}`)} ·{' '}
          {format.dateTime(new Date(entry.createdAt), { timeStyle: 'short', dateStyle: 'short' })}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm">{entry.text}</p>
      {entry.detail ? (
        <p role="note" className="text-xs text-danger">
          {entry.detail}
        </p>
      ) : null}
      {run && entry.intent !== 'steer' ? <RunCard run={run} nested /> : null}
      {entry.intent === 'steer' && entry.runId && entry.commandId ? (
        <DeliveryStatus runId={entry.runId} commandId={entry.commandId} />
      ) : null}
      {entry.intent === 'steer' && entry.runId ? (
        <Link
          to="/runs/$runId"
          params={{ runId: entry.runId }}
          search={
            entry.executionId ? { execution: entry.executionId, view: 'run' } : { view: 'run' }
          }
          className="self-start text-xs underline"
        >
          {t('openRun')}
        </Link>
      ) : null}
    </article>
  );
}

/** A run with its status and, once it has one, its final result. */
/**
 * A run in the session (02-UX-Spec §3): whether it finished or not, the agent's own result kept
 * apart from facts, and what can be done next. Links stay inside the workbench.
 */
function RunCard({ run, nested = false }: { run: RunSummary; nested?: boolean }) {
  const t = useTranslations('Sessions');
  const ts = useTranslations('Status');
  const { transport, workspaces } = useServices();
  const ended = TERMINAL_RUN_STATUSES.has(run.status);
  const [result, setResult] = useState<{ text: string; id: string } | null>(null);
  useEffect(() => {
    if (!ended) return;
    let live = true;
    void (async () => {
      const { projection } = await transport.getSnapshot(run.runId);
      const id = finalResultId(projection);
      if (!id) return;
      const text = await transport.getArtifactText(run.runId, id);
      if (live && text !== null) setResult({ text, id });
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [transport, run.runId, ended]);
  const inSession = (view: 'results' | 'run') =>
    run.sessionId ? (
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: run.sessionId }}
        search={{ tab: 'run', run: run.runId, view }}
        className="underline"
      >
        {view === 'results' ? t('openResults') : t('openRun')}
      </Link>
    ) : (
      <Link to="/runs/$runId" params={{ runId: run.runId }} search={{ view }} className="underline">
        {view === 'results' ? t('openResults') : t('openRun')}
      </Link>
    );
  return (
    <section
      aria-label={run.runId}
      data-testid={`run-card-${run.runId}`}
      className={`flex flex-col gap-2 ${nested ? 'border-t border-line pt-2' : 'rounded-lg border border-line bg-raised p-3'}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge status={run.status} />
        <span className="font-mono text-muted">{run.runId}</span>
        {inSession('results')}
        {inSession('run')}
      </div>
      {!ended ? <p className="text-xs text-muted">{t('working')}</p> : null}
      {ended && run.status === 'succeeded' ? (
        <p className="text-xs font-medium">{t('didFinish')}</p>
      ) : null}
      {ended && run.status !== 'succeeded' ? (
        <p role="note" className="text-xs text-warning">
          {t('didNotFinish', { status: ts(run.status) })}
        </p>
      ) : null}
      {result ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted">{t('agentSummary')}</p>
          <div className="max-h-72 overflow-auto rounded border border-line bg-surface p-2">
            <SafeMarkdown text={result.text} />
          </div>
        </div>
      ) : null}
      {ended && workspaces && run.sessionId ? (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">{t('nextActions')}:</span>
          <Link
            to="/sessions/$sessionId/review"
            params={{ sessionId: run.sessionId }}
            search={{ scope: 'run', runId: run.runId }}
            className="underline"
          >
            {t('reviewChanges')}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

/** Where an instruction is now, from the run's own record of it (02-UX-Spec §7). */
function DeliveryStatus({ runId, commandId }: { runId: string; commandId: string }) {
  const t = useTranslations('Sessions');
  const ts = useTranslations('Status');
  const { transport } = useServices();
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
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
        if (now && !['accepted', 'attached_to_request'].includes(now)) clearInterval(timer);
      });
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [transport, runId, commandId]);
  return status ? (
    <p data-testid="delivery" className="text-xs">
      {t('delivery', { status: ts(status) })}
    </p>
  ) : null;
}

function finalResultId(projection: RunProjection): string | null {
  return projection.output?.artifactVersionIds[0] ?? null;
}

const draftKey = (sessionId: string) => `corral:session-draft:${sessionId}`;
function readDraft(sessionId: string) {
  try {
    return window.localStorage.getItem(draftKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}
function writeDraft(sessionId: string, text: string) {
  try {
    if (text) window.localStorage.setItem(draftKey(sessionId), text);
    else window.localStorage.removeItem(draftKey(sessionId));
  } catch {
    // The draft lives only in this page then.
  }
}

function Composer({
  session,
  team,
  runs,
  active,
  queued,
  onChange,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  runs: RunSummary[];
  active: RunSummary | null;
  queued: SessionEntry[];
  onChange: () => void;
}) {
  const t = useTranslations('Sessions');
  const services = useServices();
  const { repository, transport, mode, live } = services;
  const router = useRouter();
  const [text, setText] = useState(() => readDraft(session.sessionId));
  const [chosen, setChosen] = useState<SessionIntent | null>(null);
  const [target, setTarget] = useState<string>('');
  const [runMode, setRunMode] = useState<'mock' | 'live'>('mock');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const [targetTick, setTargetTick] = useState(0);
  const ownActive = active && active.sessionId === session.sessionId ? active : null;
  const latest = useLatestResult(runs);
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
  const allowed: SessionIntent[] = active
    ? ownActive
      ? ['steer', 'queue']
      : ['queue']
    : ['next', 'explain'];
  const intent: SessionIntent =
    chosen && allowed.includes(chosen) ? chosen : (allowed[0] as SessionIntent);

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
                  label: `${definition?.nodes.find((n) => n.id === e.nodeId)?.label ?? e.nodeId} · ${e.executionId}`,
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
  const steerTarget = targets.some((x) => x.id === target) ? target : (targets[0]?.id ?? '');

  const record = async (entry: Parameters<typeof repository.addSessionEntry>[1]) => {
    const saved = await repository.addSessionEntry(session.sessionId, entry);
    if (!saved.ok) setError(t('failed', { message: saved.message }));
  };

  /** Starts a follow-up with the team; returns the run or why not. */
  const startNext = async (
    brief: string,
    commandId: string = newCommandId(),
  ): Promise<{ runId: string | null; detail: string | null }> => {
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
    return { runId: result.runId, detail: result.receipt.error?.message ?? null };
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (intent === 'next') {
        const commandId = commandFor(`next\u0000${body}`);
        const { runId, detail } = await startNext(body, commandId);
        await record({
          intent,
          text: body,
          state: runId ? 'started' : 'refused',
          runId,
          detail,
          commandId,
        });
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
      } else {
        return;
      }
      pending.current = null;
      setText('');
      writeDraft(session.sessionId, '');
      await router.invalidate();
      onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
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
    writeDraft(session.sessionId, entry.text);
    setChosen('queue');
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

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME composition's Enter confirms the text; it never sends (WB-UX-005).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    }
  };

  const unavailable =
    (intent === 'next' && !team) ||
    (intent === 'explain' && !latest) ||
    (intent === 'steer' && !steerTarget);

  return (
    <section aria-label={t('requestLabel')} className="flex flex-col gap-2">
      {queued.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border border-line p-2">
          <h3 className="text-xs font-semibold">{t('queueHeading')}</h3>
          <ul className="flex flex-col gap-1">
            {queued.map((entry) => (
              <li key={entry.entryId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{entry.text}</span>
                <button
                  type="button"
                  disabled={Boolean(active) || busy || !team}
                  onClick={() => void startQueued(entry)}
                  className="rounded border border-accent px-2 py-0.5 text-xs text-accent disabled:opacity-50"
                >
                  {t('startNow')}
                </button>
                <button
                  type="button"
                  onClick={() => void editQueued(entry)}
                  className="rounded border border-line px-2 py-0.5 text-xs"
                >
                  {t('editQueued')}
                </button>
                <button
                  type="button"
                  onClick={() => void removeQueued(entry)}
                  className="rounded border border-line px-2 py-0.5 text-xs"
                >
                  {t('remove')}
                </button>
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
            />
            <span>
              {t('autoStart')}
              <span className="block text-muted">{t('autoStartHint')}</span>
            </span>
          </label>
        </div>
      ) : null}
      {active && !ownActive ? (
        <p role="note" className="text-xs text-warning">
          {t('busyElsewhere', { runId: active.runId })}
        </p>
      ) : null}
      <fieldset className="flex flex-wrap gap-1 text-xs">
        <legend className="sr-only">{t('intentLabel')}</legend>
        {allowed.map((value) => (
          <label
            key={value}
            className={`cursor-pointer rounded px-2 py-1 focus-within:outline-2 focus-within:outline-accent ${
              intent === value ? 'bg-accent text-on-accent' : 'border border-line'
            }`}
          >
            <input
              type="radio"
              name="session-intent"
              value={value}
              checked={intent === value}
              onChange={() => setChosen(value)}
              className="sr-only"
            />
            {t(`intent.${value}`)}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted">{t(`intentHint.${intent}`)}</p>
      {intent === 'steer' && steerTarget ? (
        <p
          data-testid="target-chip"
          className="self-start rounded-full border border-accent px-2 py-0.5 text-xs"
        >
          {t('targetChip', {
            label: targets.find((x) => x.id === steerTarget)?.label ?? steerTarget,
          })}
        </p>
      ) : null}
      {intent === 'steer' ? (
        <label className="flex items-center gap-2 text-xs">
          {t('target')}
          <select
            value={steerTarget}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded border border-line bg-surface px-1 py-0.5"
          >
            {targets.length === 0 ? <option value="">{t('noTarget')}</option> : null}
            {targets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {(intent === 'next' || intent === 'explain') && latest ? (
        <p className="text-xs text-muted">{t('fromResult', { label: latest.label })}</p>
      ) : null}
      {(intent === 'next' || intent === 'explain') && team ? (
        <PreRunSummary session={session} team={team} mode={runMode} intent={intent} />
      ) : null}
      {intent === 'next' && !team ? <p className="text-xs text-warning">{t('noTeamYet')}</p> : null}
      {intent === 'explain' && !latest ? (
        <p className="text-xs text-warning">{t('noResult')}</p>
      ) : null}
      <textarea
        aria-label={t('requestLabel')}
        value={text}
        rows={4}
        onChange={(e) => {
          setText(e.target.value);
          writeDraft(session.sessionId, e.target.value);
        }}
        onKeyDown={onKeyDown}
        className="rounded border border-line bg-surface p-2 text-sm"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">{t('sendHint')}</span>
        <div className="flex items-center gap-2">
          {mode === 'server' && live && (intent === 'next' || intent === 'explain') ? (
            <label className="flex items-center gap-1 text-xs">
              {t('mode')}
              <select
                value={runMode}
                onChange={(e) => setRunMode(e.target.value as 'mock' | 'live')}
                className="rounded border border-line bg-surface px-1 py-0.5"
              >
                <option value="mock">{t('modeMock')}</option>
                <option value="live">{t('modeLive')}</option>
              </select>
            </label>
          ) : null}
          <button
            type="button"
            disabled={busy || !text.trim() || unavailable}
            onClick={() => void send()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
          >
            {t('send')}
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
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
  // A new team revision changes what the next run would use.
  const revision = team.definitionRevision;
  useEffect(() => {
    void revision;
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
  }, [repository, workspaces, session.sessionId, team.corralId, revision, mode, intent, t]);
  return text ? (
    <p data-testid="pre-run" className="text-xs text-muted">
      {text}
    </p>
  ) : null;
}
