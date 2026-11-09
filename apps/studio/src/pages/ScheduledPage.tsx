import type { Schedule, ScheduleDraft, ScheduledOccurrence } from '@corral/contracts';
import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { StatusBadge } from '@corral/react';
import { Button, Input, Select, Switch, Textarea } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { projectName } from '../projects.ts';
import { schedulesApi } from '../schedules-api.ts';
import { useServices } from '../services.tsx';
import { watchRefresh } from '../workbench/refresh.ts';
import { scheduleHistoryStatus } from '../workbench/scheduledRuns.ts';

/** Sunday first, as the rule's weekday numbers count them. */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

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

/** Server-owned schedules; no renderer timer dispatches work. */
export function ScheduledPage() {
  const { repository, models, mode, live, transport } = useServices();
  const t = useTranslations('Schedules');
  const tp = useTranslations('Projects');
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<Schedule | null>(null);
  const [history, setHistory] = useState<ScheduledOccurrence[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [savedEnabled, setSavedEnabled] = useState<boolean | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const manualCommand = useRef<{ scheduleId: string; revision: number; id: string } | null>(null);
  const dirty =
    selected && draft && JSON.stringify(scheduleDraft(selected)) !== JSON.stringify(draft);
  const refresh = async () => setSchedules((await schedulesApi.list()).schedules);
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
  const selectedId = selected?.id;
  const selectedRevision = selected?.revision;
  useEffect(() => {
    if (mode !== 'server') return;
    void selectedRevision;
    const watcher = watchRefresh(async (current) => {
      try {
        const [result, records, latestRuns] = await Promise.all([
          schedulesApi.list(),
          selectedId ? schedulesApi.history(selectedId) : Promise.resolve(null),
          transport.listRuns(),
        ]);
        if (!current()) return;
        setSchedules(result.schedules);
        setRuns(latestRuns);
        if (records) setHistory(records.occurrences);
        setReadError(null);
      } catch (cause) {
        if (current()) setReadError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 3000);
    return watcher.dispose;
  }, [mode, selectedId, selectedRevision, transport]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const edit = (schedule: Schedule) => {
    setSavedEnabled(null);
    setSelected(schedule);
    setDraft(scheduleDraft(schedule));
    setHistory([]);
  };
  const create = () => {
    const session = sessions[0];
    if (!session) return;
    setSelected(null);
    setSavedEnabled(null);
    setHistory([]);
    setDraft({
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
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    void perform(async () => {
      const saved = selected
        ? await schedulesApi.update(selected, draft)
        : await schedulesApi.create(draft);
      edit(saved);
      setSavedEnabled(saved.enabled);
    });
  };
  const ids = useId();
  const labelClass = 'flex min-w-0 flex-col gap-1.5 text-caption text-muted-foreground';
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <Button disabled={mode !== 'server' || !sessions.length || busy} onClick={create}>
          {t('new')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('whenRuns')}</p>
      <p className="text-sm text-muted-foreground">{t('howRuns')}</p>
      {mode !== 'server' ? <p>{t('serverOnly')}</p> : null}
      {loaded && !sessions.length ? <p>{t('needsSession')}</p> : null}
      {readError ? (
        <p role="alert" className="text-sm text-danger">
          {readError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {schedules.map((schedule) => (
          <li key={schedule.id} className="flex items-center gap-2">
            <Button
              variant="ghost"
              aria-pressed={selected?.id === schedule.id}
              className="h-auto min-w-0 flex-1 justify-start py-2 text-left"
              onClick={() => edit(schedule)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{schedule.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {schedule.enabled ? t('enabled') : t('disabled')}
                  {' · '}
                  {schedule.nextAt ? new Date(schedule.nextAt).toLocaleString() : t('noUpcoming')}
                </span>
              </span>
            </Button>
            <Button
              variant="ghost"
              size="compact"
              render={<Link to="/sessions/$sessionId" params={{ sessionId: schedule.sessionId }} />}
            >
              {t('session')}
            </Button>
          </li>
        ))}
      </ul>
      {draft ? (
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 border-t border-line pt-4"
          aria-label={t('settings')}
        >
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
          <Switch
            label={t('enable')}
            checked={draft.enabled}
            onToggle={() => setDraft({ ...draft, enabled: !draft.enabled })}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} type="submit">
              {t('save')}
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setDraft(null);
                setSelected(null);
              }}
            >
              {t('close')}
            </Button>
            {selected ? (
              <>
                <Button
                  variant="tertiary"
                  disabled={busy || !!dirty}
                  type="button"
                  onClick={() => {
                    if (
                      manualCommand.current?.scheduleId !== selected.id ||
                      manualCommand.current?.revision !== selected.revision
                    ) {
                      manualCommand.current = {
                        scheduleId: selected.id,
                        revision: selected.revision,
                        id: `manual_${crypto.randomUUID()}`,
                      };
                    }
                    const commandId = manualCommand.current.id;
                    void perform(async () => {
                      setHistory((await schedulesApi.run(selected, commandId)).occurrences);
                      manualCommand.current = null;
                    });
                  }}
                >
                  {t('runNow')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void perform(async () => {
                      await schedulesApi.remove(selected);
                      setDraft(null);
                      setSelected(null);
                    })
                  }
                >
                  {t('delete')}
                </Button>
              </>
            ) : null}
          </div>
          {savedEnabled !== null && !dirty ? (
            <p role="status" className="text-sm">
              {t(savedEnabled ? 'savedEnabled' : 'savedDisabled')}
            </p>
          ) : null}
          {dirty ? <p className="text-xs text-muted-foreground">{t('saveFirst')}</p> : null}
        </form>
      ) : null}
      {selected && history.length ? (
        <section aria-label={t('history')} className="border-t border-line pt-4">
          <h3 className="mb-2 font-medium">{t('history')}</h3>
          <ul className="divide-y divide-line">
            {history.map((entry) => (
              <li key={entry.id} className="py-2 text-sm">
                <span>
                  {new Date(entry.dueAt).toLocaleString()} ·{' '}
                  {t('dispatch', { status: t(`occurrence.${entry.status}`) })}
                </span>
                {entry.runId ? (
                  <span className="ml-2">
                    {scheduleHistoryStatus(entry, runs) ? (
                      <StatusBadge status={scheduleHistoryStatus(entry, runs) ?? ''} />
                    ) : (
                      t('unavailable')
                    )}
                  </span>
                ) : null}
                {entry.detail ? (
                  <p className="text-xs text-muted-foreground">{entry.detail}</p>
                ) : null}
                {entry.runId ? (
                  <Button
                    variant="ghost"
                    size="compact"
                    className="-ml-2"
                    render={
                      <Link
                        to="/sessions/$sessionId"
                        params={{ sessionId: selected.sessionId }}
                        search={{ panel: 'run', view: 'run', run: entry.runId }}
                      />
                    }
                  >
                    {t('openRunRespond')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
