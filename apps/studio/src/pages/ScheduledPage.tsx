import type { Schedule, ScheduleDraft, ScheduledOccurrence, ScheduleRule } from '@corral/contracts';
import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { StatusBadge } from '@corral/react';
import {
  Button,
  EmptyState,
  fontWeights,
  Input,
  Page,
  SectionLabel,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { projectName } from '../projects.ts';
import { schedulesApi } from '../schedules-api.ts';
import { useServices } from '../services.tsx';
import { ABOVE_CHOSEN_TABLE_ROW, CHOSEN_TABLE_ROW } from '../workbench/chosenRow.ts';
import { watchRefresh } from '../workbench/refresh.ts';
import { watchRunList } from '../workbench/runList.ts';
import { scheduleHistoryStatus } from '../workbench/scheduledRuns.ts';

/** Sunday first, as the rule's weekday numbers count them. */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;
const semibold = { fontVariationSettings: fontWeights.semibold };

function scheduleDraft(schedule: Schedule): ScheduleDraft {
  const {
    id: _id,
    revision: _revision,
    createdAt: _created,
    updatedAt: _updated,
    nextAt: _next,
    deletedAt: _deleted,
    ...value
  } = schedule;
  return value;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** A session read on its own, so a title its runs gave it since the page opened shows. */
const readTarget = (
  repository: { getSession(id: string): Promise<WorkSession | null> },
  sessionId: string,
) =>
  Promise.resolve()
    .then(() => repository.getSession(sessionId))
    .then((session) => ({ sessionId, session: session ?? null }));

/**
 * Server-owned schedules; no renderer timer dispatches work. The list leads to one schedule's
 * details and its history, where each firing's result stays apart from its run's own status.
 */
export function ScheduledPage() {
  const { repository, models, mode, live, transport } = useServices();
  const t = useTranslations('Schedules');
  const tp = useTranslations('Projects');
  const shell = useTranslations('Shell');
  const format = useFormatter();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<Schedule | null>(null);
  /** Each schedule's occurrences, newest first. */
  const [histories, setHistories] = useState<Record<string, ScheduledOccurrence[]>>({});
  /** Null until read, and after a failed read: a run's status is then unknown. */
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [savedEnabled, setSavedEnabled] = useState<boolean | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  /** The editor: a new schedule (`base` null) or a change to `base`. */
  const [editing, setEditing] = useState<{ base: Schedule | null; draft: ScheduleDraft } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** The shown schedule's session as last read: its current title, or null once it is gone. */
  const [target, setTarget] = useState<{ sessionId: string; session: WorkSession | null } | null>(
    null,
  );
  // A second click lands before the disabled state renders; one action at a time.
  const inFlight = useRef(false);
  const manualCommand = useRef<{ scheduleId: string; revision: number; id: string } | null>(null);
  // The listing holds the current revision; the snapshot covers the moment before it is read.
  const shown = selected ? (schedules.find((s) => s.id === selected.id) ?? selected) : null;
  const chosenIndex = shown ? schedules.findIndex((s) => s.id === shown.id) : -1;
  const selectedId = useRef<string | null>(null);
  selectedId.current = selected?.id ?? null;
  const targetId = useRef<string | null>(null);
  targetId.current = shown?.sessionId ?? null;
  const reads = useRef(0);
  /**
   * The list and histories: every schedule's when `every`, else only the one shown. An older read
   * that finishes after a newer one has started is dropped. Runs come from the shared run list.
   */
  const readSchedules = async (every: boolean, current: () => boolean = () => true) => {
    const id = ++reads.current;
    const chosen = selectedId.current;
    const chosenTarget = targetId.current;
    const [listed, session] = await Promise.allSettled([
      schedulesApi.list().then(async ({ schedules }) => ({
        schedules,
        histories: Object.fromEntries(
          await Promise.all(
            schedules
              .filter((schedule) => every || schedule.id === chosen)
              .map(
                async (schedule) =>
                  [schedule.id, (await schedulesApi.history(schedule.id)).occurrences] as const,
              ),
          ),
        ),
      })),
      chosenTarget ? readTarget(repository, chosenTarget) : Promise.resolve(null),
    ]);
    if (!current() || id !== reads.current) return;
    // A failed read keeps the title shown before; only an answer says the session is gone.
    if (session.status === 'fulfilled' && session.value) setTarget(session.value);
    if (listed.status === 'fulfilled') {
      setSchedules(listed.value.schedules);
      setHistories((known) =>
        every ? listed.value.histories : { ...known, ...listed.value.histories },
      );
      setReadError(null);
    } else setReadError(message(listed.reason));
  };
  const readRef = useRef(readSchedules);
  readRef.current = readSchedules;
  // The run list the sidebar and its scheduled-run notice read: when a run settles, its history
  // row changes with the same snapshot that raises the notice, not at this page's next tick.
  const runList = useRef<{ refresh(): void } | null>(null);
  useEffect(() => {
    if (mode !== 'server') return;
    const watcher = watchRunList(transport, async (result, current) => {
      if (!current()) return;
      // A failed run lookup never leaves an older status standing in for the current one.
      setRuns('error' in result ? null : result.runs);
    });
    runList.current = watcher;
    return () => {
      runList.current = null;
      watcher.dispose();
    };
  }, [mode, transport]);
  const refresh = () => {
    runList.current?.refresh();
    return readSchedules(true);
  };
  useEffect(() => {
    if (mode !== 'server') return;
    let active = true;
    void Promise.all([
      repository.listProjects().then(async (projects) => {
        if (active) setProjects(projects.filter((project) => !project.archivedAt));
        return (
          await Promise.all(
            projects
              .filter((p) => !p.archivedAt)
              .map((project) => repository.listSessions(project.projectId)),
          )
        )
          .flat()
          .filter((session) => !session.archivedAt && !session.corralId);
      }),
      models?.profiles() ?? Promise.resolve([]),
    ])
      .then(([available, configured]) => {
        if (!active) return;
        setSessions(available);
        setProfiles(configured.map((profile) => profile.profileId));
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setError(String(cause.message));
      });
    return () => {
      active = false;
    };
  }, [repository, models, mode]);
  // Choosing a schedule reads its session at once rather than at the next tick.
  const shownTarget = shown?.sessionId;
  useEffect(() => {
    if (mode !== 'server' || !shownTarget) return;
    let active = true;
    readTarget(repository, shownTarget).then(
      (read) => {
        if (active) setTarget(read);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [mode, shownTarget, repository]);
  useEffect(() => {
    if (mode !== 'server') return;
    // Opening, focus and reconnection read every history; the tick reads only the one shown.
    const watcher = watchRefresh((current, every) => readRef.current(every, current), 3000);
    return watcher.dispose;
  }, [mode]);
  const perform = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const select = (schedule: Schedule) => {
    setSavedEnabled(null);
    setError(null);
    setEditing(null);
    setSelected(schedule);
  };
  const create = () => {
    const session = sessions[0];
    if (!session) return;
    setSelected(null);
    setSavedEnabled(null);
    setEditing({
      base: null,
      draft: {
        title: '',
        hostId: 'local',
        projectId: session.projectId,
        sessionId: session.sessionId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        rule: { kind: 'daily', time: '09:00' },
        enabled: false,
        request: {
          brief: '',
          choice: session.auto ?? { modelProfile: profiles[0] ?? 'simulated' },
          mode: 'mock',
          permissionMode: 'ask',
          configRevision: 1,
        },
      },
    });
  };
  const save = (draft: ScheduleDraft) => {
    const base = editing?.base ?? null;
    void perform(async () => {
      const saved = base
        ? await schedulesApi.update(base, draft)
        : await schedulesApi.create(draft);
      select(saved);
      setSavedEnabled(saved.enabled);
    });
  };
  /** Stops or resumes future firings only; a run already started keeps going. */
  const setEnabled = (schedule: Schedule, enabled: boolean) =>
    void perform(async () => {
      const saved = await schedulesApi.update(schedule, { ...scheduleDraft(schedule), enabled });
      setSelected(saved);
      setSavedEnabled(saved.enabled);
    });
  const runNow = (schedule: Schedule) => {
    // A retry after a lost response reuses its command ID, so it never starts a second run.
    if (
      manualCommand.current?.scheduleId !== schedule.id ||
      manualCommand.current?.revision !== schedule.revision
    )
      manualCommand.current = {
        scheduleId: schedule.id,
        revision: schedule.revision,
        id: `manual_${crypto.randomUUID()}`,
      };
    const commandId = manualCommand.current.id;
    void perform(async () => {
      const { occurrences } = await schedulesApi.run(schedule, commandId);
      setHistories((current) => ({ ...current, [schedule.id]: occurrences }));
      manualCommand.current = null;
    });
  };
  const remove = (schedule: Schedule) =>
    void perform(async () => {
      await schedulesApi.remove(schedule);
      setSelected(null);
      setSavedEnabled(null);
    });
  const summary = (rule: ScheduleRule) =>
    rule.kind === 'once'
      ? t('summaryOnce', { time: format.dateTime(new Date(rule.at), DATE_TIME) })
      : rule.kind === 'daily'
        ? t('summaryDaily', { time: rule.time })
        : t('summaryWeekly', {
            days: [...rule.weekdays]
              .sort((a, b) => a - b)
              .map((day) => t(`weekday.${WEEKDAYS[day] ?? 'sun'}`))
              .join(', '),
            time: rule.time,
          });
  // A disabled schedule has no next run, whatever time its rule would give.
  const nextRun = (schedule: Schedule) =>
    schedule.enabled && schedule.nextAt
      ? format.dateTime(new Date(schedule.nextAt), DATE_TIME)
      : t('noUpcoming');
  /** The run's own current or final status; unknown when it cannot be read, never assumed. */
  const runStatus = (occurrence: ScheduledOccurrence) => {
    const status = scheduleHistoryStatus(occurrence, runs ?? []);
    return status ? <StatusBadge status={status} /> : <span>{t('unavailable')}</span>;
  };
  const lastResult = (schedule: Schedule) => {
    const latest = histories[schedule.id]?.[0];
    if (!latest) return t('notRun');
    return latest.runId ? runStatus(latest) : t(`occurrence.${latest.status}`);
  };
  // Without the local server the empty state's title is the reason, as in Library resources.
  // Its one line is what New schedule waits for, while there is no session to run in.
  const empty =
    mode !== 'server'
      ? { title: t('localOnly'), text: undefined }
      : {
          title: t('emptyTitle'),
          text: loaded && !sessions.length ? t('needsSession') : undefined,
        };
  /** The session's current name when it can be read, else the one listed when the page opened. */
  const targetSession = (sessionId: string) =>
    target?.sessionId === sessionId
      ? target.session
      : (sessions.find((session) => session.sessionId === sessionId) ?? undefined);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <Page
        title={shell('automation')}
        // Without the local server there is nothing to create; the empty state says why.
        {...(mode === 'server'
          ? {
              toolbar: (
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={!sessions.length || busy} onClick={create}>
                    {t('new')}
                  </Button>
                </div>
              ),
            }
          : {})}
      >
        {readError ? (
          <p role="alert" className="text-body text-destructive">
            {readError}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
        ) : null}
        {schedules.length ? (
          <div className="min-w-0 overflow-x-auto">
            <Table aria-label={t('title')}>
              <TableHeader>
                <TableRow className={chosenIndex === 0 ? ABOVE_CHOSEN_TABLE_ROW : undefined}>
                  <TableHead>{t('name')}</TableHead>
                  <TableHead className="max-md:hidden">{t('schedule')}</TableHead>
                  <TableHead>{t('state')}</TableHead>
                  <TableHead className="max-md:hidden">{t('nextRun')}</TableHead>
                  <TableHead>{t('lastResult')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((schedule, index) => {
                  const current = index === chosenIndex;
                  return (
                    <TableRow
                      key={schedule.id}
                      index={index}
                      data-selected={current}
                      className={
                        current
                          ? CHOSEN_TABLE_ROW
                          : index === chosenIndex - 1
                            ? ABOVE_CHOSEN_TABLE_ROW
                            : undefined
                      }
                    >
                      <TableCell className="w-1/3 max-w-0">
                        {/* The row's one control; it stretches over the row for the pointer. */}
                        <button
                          type="button"
                          aria-pressed={current}
                          onClick={() => select(schedule)}
                          className="block w-full truncate rounded-sm text-left text-foreground after:absolute after:inset-0 after:content-['']"
                          style={current ? semibold : undefined}
                        >
                          {schedule.title}
                        </button>
                      </TableCell>
                      <TableCell className="max-md:hidden">{summary(schedule.rule)}</TableCell>
                      <TableCell>{schedule.enabled ? t('enabled') : t('disabled')}</TableCell>
                      <TableCell className="tabular-nums max-md:hidden">
                        {nextRun(schedule)}
                      </TableCell>
                      <TableCell>{lastResult(schedule)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : editing ? null : (
          <EmptyState title={empty.title} text={empty.text} />
        )}
        {editing ? (
          <ScheduleEditor
            key={editing.base?.id ?? 'new'}
            initial={editing.draft}
            sessions={sessions}
            projects={projects}
            profiles={profiles}
            live={live}
            busy={busy}
            onSave={save}
            onClose={() => setEditing(null)}
          />
        ) : shown ? (
          <ScheduleDetail
            schedule={shown}
            summary={summary(shown.rule)}
            nextRun={nextRun(shown)}
            projectLabel={projectName(
              projects.find((project) => project.projectId === shown.projectId),
              tp('defaultName'),
            )}
            session={targetSession(shown.sessionId)}
            busy={busy}
            savedEnabled={savedEnabled}
            onRun={() => runNow(shown)}
            onEnabled={(enabled) => setEnabled(shown, enabled)}
            onEdit={() => {
              setSavedEnabled(null);
              setEditing({ base: shown, draft: scheduleDraft(shown) });
            }}
            onDelete={() => remove(shown)}
          />
        ) : null}
        {shown && !editing ? (
          <section aria-label={t('history')} className="flex min-w-0 flex-col gap-3">
            <SectionLabel count={histories[shown.id]?.length ?? 0}>{t('history')}</SectionLabel>
            {histories[shown.id]?.length ? (
              <div className="min-w-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('due')}</TableHead>
                      {/* Narrow: the firing's result stacks under its time, like the list above. */}
                      <TableHead className="max-md:hidden">{t('dispatchResult')}</TableHead>
                      <TableHead>{t('runStatus')}</TableHead>
                      <TableHead>
                        <span className="sr-only">{t('openRun')}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {histories[shown.id]?.map((entry, index) => {
                      // Known to wait for the person (from the runs already read): respond.
                      const waiting = scheduleHistoryStatus(entry, runs ?? []) === 'awaiting_user';
                      return (
                        <TableRow key={entry.id} index={index}>
                          <TableCell className="tabular-nums">
                            {format.dateTime(new Date(entry.dueAt), DATE_TIME)}
                            {entry.manual ? ` · ${t('manual')}` : ''}
                            <span className="block text-caption md:hidden">
                              {t(`occurrence.${entry.status}`)}
                              {entry.detail ? ` · ${entry.detail}` : ''}
                            </span>
                          </TableCell>
                          <TableCell className="max-md:hidden">
                            {t(`occurrence.${entry.status}`)}
                            {entry.detail ? (
                              <p className="m-0 text-caption text-muted-foreground">
                                {entry.detail}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell>{entry.runId ? runStatus(entry) : null}</TableCell>
                          <TableCell className="text-right">
                            {entry.runId ? (
                              <Button
                                variant="ghost"
                                size="compact"
                                render={
                                  <Link
                                    to="/sessions/$sessionId"
                                    params={{ sessionId: shown.sessionId }}
                                    search={{
                                      panel: 'run',
                                      view: 'run',
                                      run: entry.runId,
                                      ...(waiting ? { respond: true as const } : {}),
                                    }}
                                  />
                                }
                              >
                                {t(waiting ? 'respond' : 'openRun')}
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="m-0 text-body text-muted-foreground">{t('notRun')}</p>
            )}
          </section>
        ) : null}
      </Page>
    </main>
  );
}

function ScheduleDetail({
  schedule,
  summary,
  nextRun,
  projectLabel,
  session,
  busy,
  savedEnabled,
  onRun,
  onEnabled,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  summary: string;
  nextRun: string;
  projectLabel: string;
  /** Undefined until read; null when the session no longer exists. */
  session: WorkSession | null | undefined;
  busy: boolean;
  savedEnabled: boolean | null;
  onRun(): void;
  onEnabled(enabled: boolean): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const t = useTranslations('Schedules');
  const heading = useId();
  const term = 'text-caption text-muted-foreground';
  return (
    <section aria-labelledby={heading} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id={heading}
          className="m-0 min-w-0 flex-1 basis-48 truncate text-title"
          style={semibold}
        >
          {schedule.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={busy} onClick={onRun}>
            {t('runNow')}
          </Button>
          <Button variant="tertiary" disabled={busy} onClick={onEdit}>
            {t('edit')}
          </Button>
          <Button variant="ghost-destructive" disabled={busy} onClick={onDelete}>
            {t('delete')}
          </Button>
        </div>
      </div>
      <dl className="m-0 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className={term}>{t('schedule')}</dt>
          <dd className="m-0 text-body">
            {summary}
            {schedule.rule.kind === 'once' ? '' : ` · ${schedule.timezone}`}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className={term}>{t('target')}</dt>
          <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1 text-body">
            <span className="truncate">{projectLabel}</span>
            <span aria-hidden className="text-muted-foreground">
              /
            </span>
            {session ? (
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: schedule.sessionId }}
                className="truncate rounded-sm text-foreground hover:underline"
              >
                {session.title}
              </Link>
            ) : (
              <span className="truncate text-muted-foreground">
                {t(session === null ? 'targetMissing' : 'session')}
              </span>
            )}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className={term}>{t('nextRun')}</dt>
          <dd className="m-0 text-body tabular-nums">{nextRun}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className={term}>{t('execution')}</dt>
          <dd className="m-0 text-body">
            {schedule.request.mode === 'live' ? t('connectedModel') : t('simulation')}
          </dd>
        </div>
      </dl>
      <Switch
        label={t('enable')}
        checked={schedule.enabled}
        disabled={busy}
        onToggle={() => onEnabled(!schedule.enabled)}
      />
      {savedEnabled !== null ? (
        <p role="status" className="m-0 text-body">
          {t(savedEnabled ? 'savedEnabled' : 'savedDisabled')}
        </p>
      ) : null}
    </section>
  );
}

function ScheduleEditor({
  initial,
  sessions,
  projects,
  profiles,
  live,
  busy,
  onSave,
  onClose,
}: {
  initial: ScheduleDraft;
  sessions: WorkSession[];
  projects: ProjectSummary[];
  profiles: string[];
  live: boolean;
  busy: boolean;
  onSave(draft: ScheduleDraft): void;
  onClose(): void;
}) {
  const t = useTranslations('Schedules');
  const tp = useTranslations('Projects');
  const [draft, setDraft] = useState(initial);
  const ids = useId();
  const labelClass = 'flex min-w-0 flex-col gap-1.5 text-caption text-muted-foreground';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(draft);
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4" aria-label={t('settings')}>
      <label htmlFor={`${ids}-title`} className={labelClass}>
        {t('name')}
        <Input
          id={`${ids}-title`}
          required
          maxLength={120}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={labelClass}>
          <span aria-hidden="true">{t('project')}</span>
          <Select
            label={t('project')}
            value={draft.projectId}
            onValueChange={(projectId) => {
              const session = sessions.find((s) => s.projectId === projectId);
              if (session)
                setDraft({
                  ...draft,
                  projectId: session.projectId,
                  sessionId: session.sessionId,
                });
            }}
            options={projects
              .filter((project) =>
                sessions.some((session) => session.projectId === project.projectId),
              )
              .map((project) => ({
                value: project.projectId,
                label: projectName(project, tp('defaultName')),
              }))}
          />
        </div>
        <div className={labelClass}>
          <span aria-hidden="true">{t('session')}</span>
          <Select
            label={t('session')}
            value={draft.sessionId}
            onValueChange={(sessionId) => {
              const session = sessions.find((s) => s.sessionId === sessionId);
              if (session)
                setDraft({
                  ...draft,
                  sessionId: session.sessionId,
                  projectId: session.projectId,
                });
            }}
            options={sessions
              .filter((session) => session.projectId === draft.projectId)
              .map((session) => ({ value: session.sessionId, label: session.title }))}
          />
        </div>
      </div>
      <label htmlFor={`${ids}-request`} className={labelClass}>
        {t('request')}
        <Textarea
          id={`${ids}-request`}
          required
          maxLength={20000}
          rows={4}
          value={draft.request.brief}
          onChange={(e) =>
            setDraft({ ...draft, request: { ...draft.request, brief: e.target.value } })
          }
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={labelClass}>
          <span aria-hidden="true">{t('repeat')}</span>
          <Select
            label={t('repeat')}
            value={draft.rule.kind}
            onValueChange={(kind) =>
              setDraft({
                ...draft,
                rule:
                  kind === 'once'
                    ? { kind: 'once', at: new Date(Date.now() + 3600000).toISOString() }
                    : kind === 'weekly'
                      ? { kind: 'weekly', time: '09:00', weekdays: [1] }
                      : { kind: 'daily', time: '09:00' },
              })
            }
            options={[
              { value: 'once', label: t('once') },
              { value: 'daily', label: t('daily') },
              { value: 'weekly', label: t('weekly') },
            ]}
          />
        </div>
        <label htmlFor={`${ids}-time`} className={labelClass}>
          {draft.rule.kind === 'once' ? t('utcTime') : t('localTime')}
          <Input
            id={`${ids}-time`}
            required
            nativeInput
            type={draft.rule.kind === 'once' ? 'datetime-local' : 'time'}
            value={draft.rule.kind === 'once' ? draft.rule.at.slice(0, 16) : draft.rule.time}
            onChange={(e) => {
              if (!e.target.value) return;
              setDraft({
                ...draft,
                rule:
                  draft.rule.kind === 'once'
                    ? { kind: 'once', at: new Date(`${e.target.value}Z`).toISOString() }
                    : { ...draft.rule, time: e.target.value },
              });
            }}
          />
        </label>
        <label htmlFor={`${ids}-zone`} className={labelClass}>
          {t('timeZone')}
          <Input
            id={`${ids}-zone`}
            required
            value={draft.timezone}
            onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
          />
        </label>
      </div>
      {draft.rule.kind === 'weekly' ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-caption text-muted-foreground">{t('days')}</legend>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((day) => t(`weekday.${day}`)).map((day, index) => {
              const on = draft.rule.kind === 'weekly' && draft.rule.weekdays.includes(index);
              return (
                <Button
                  key={day}
                  size="compact"
                  variant={on ? 'secondary' : 'ghost'}
                  aria-pressed={on}
                  onClick={() => {
                    if (draft.rule.kind === 'weekly')
                      setDraft({
                        ...draft,
                        rule: {
                          ...draft.rule,
                          weekdays: on
                            ? draft.rule.weekdays.filter((d) => d !== index)
                            : [...draft.rule.weekdays, index],
                        },
                      });
                  }}
                >
                  {day}
                </Button>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <p className="m-0 text-caption text-muted-foreground">{t('whenRuns')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={labelClass}>
          <span aria-hidden="true">{t('modelProfile')}</span>
          <Select
            label={t('modelProfile')}
            value={draft.request.choice.modelProfile}
            onValueChange={(modelProfile) =>
              setDraft({
                ...draft,
                request: { ...draft.request, choice: { modelProfile } },
              })
            }
            options={[...new Set([...profiles, draft.request.choice.modelProfile])].map(
              (profile) => ({ value: profile, label: profile }),
            )}
          />
        </div>
        <div className={labelClass}>
          <span aria-hidden="true">{t('execution')}</span>
          <Select
            label={t('execution')}
            value={draft.request.mode}
            onValueChange={(value) =>
              setDraft({ ...draft, request: { ...draft.request, mode: value } })
            }
            options={[
              { value: 'mock' as const, label: t('simulation') },
              {
                value: 'live' as const,
                label: t('connectedModel'),
                disabled: !live,
              },
            ]}
          />
        </div>
        <div className={labelClass}>
          <span aria-hidden="true">{t('permissions')}</span>
          <Select
            label={t('permissions')}
            value={draft.request.permissionMode}
            onValueChange={(permissionMode) =>
              setDraft({ ...draft, request: { ...draft.request, permissionMode } })
            }
            options={[
              { value: 'ask' as const, label: t('permission.ask') },
              { value: 'accept_edits' as const, label: t('permission.accept_edits') },
              { value: 'auto' as const, label: t('permission.auto') },
            ]}
          />
        </div>
      </div>
      <p className="m-0 text-caption text-muted-foreground">{t('howRuns')}</p>
      <Switch
        label={t('enable')}
        checked={draft.enabled}
        onToggle={() => setDraft({ ...draft, enabled: !draft.enabled })}
      />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} type="submit">
          {t('save')}
        </Button>
        <Button variant="ghost" type="button" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    </form>
  );
}
