import type { Schedule, ScheduleDraft, ScheduledOccurrence } from '@corral/contracts';
import type { ProjectSummary, RunSummary, WorkSession } from '@corral/core';
import { StatusBadge } from '@corral/react';
import { Button, Input, Select, Switch, Textarea } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { projectName } from '../projects.ts';
import { schedulesApi } from '../schedules-api.ts';
import { useServices } from '../services.tsx';
import { watchRefresh } from '../workbench/refresh.ts';
import { scheduleHistoryStatus } from '../workbench/scheduledRuns.ts';

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
  const ko = useLocale().startsWith('ko');
  const t = useTranslations('Schedules');
  const tp = useTranslations('Projects');
  const text = (en: string, kr: string) => (ko ? kr : en);
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
        <h2 className="text-xl font-semibold">{text('Schedules', '예약 실행')}</h2>
        <Button disabled={mode !== 'server' || !sessions.length || busy} onClick={create}>
          {text('New schedule', '새 예약')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {text(
          'Runs while this server is open. Missed times and overlapping runs are skipped and recorded. A repeated daylight-saving time runs once, at its earlier instant; nonexistent times are skipped.',
          '서버가 켜져 있을 때 실행합니다. 놓친 시각과 이전 실행 중의 예약은 건너뛰고 기록합니다. 일광 절약 시간으로 시각이 반복되면 첫 시각에 한 번 실행하며, 존재하지 않는 시각은 건너뜁니다.',
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        {text(
          'Requests use the normal Auto team, its model and budget limits, and your selected permission mode. Approval requests wait in the session. Disabling or deleting a schedule does not cancel an already started run.',
          '일반 Auto 팀과 해당 모델·예산 한도, 선택한 권한 모드를 사용합니다. 승인이 필요하면 세션에서 기다립니다. 예약 비활성화·삭제는 이미 시작한 실행을 취소하지 않습니다.',
        )}
      </p>
      {mode !== 'server' ? (
        <p>
          {text('Schedules require the local server.', '예약은 로컬 서버에서 사용할 수 있습니다.')}
        </p>
      ) : null}
      {loaded && !sessions.length ? (
        <p>
          {text(
            'Create an Auto session in a project first.',
            '프로젝트에서 Auto 세션을 먼저 만들어 주세요.',
          )}
        </p>
      ) : null}
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
                  {schedule.enabled ? text('Enabled', '활성') : text('Disabled', '비활성')}
                  {' · '}
                  {schedule.nextAt
                    ? new Date(schedule.nextAt).toLocaleString()
                    : text('No upcoming run', '다음 실행 없음')}
                </span>
              </span>
            </Button>
            <Button
              variant="ghost"
              size="compact"
              render={<Link to="/sessions/$sessionId" params={{ sessionId: schedule.sessionId }} />}
            >
              {text('Session', '세션')}
            </Button>
          </li>
        ))}
      </ul>
      {draft ? (
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 border-t border-line pt-4"
          aria-label={text('Schedule settings', '예약 설정')}
        >
          <label htmlFor={`${ids}-title`} className={labelClass}>
            {text('Title', '이름')}
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
              <span aria-hidden="true">{text('Project', '프로젝트')}</span>
              <Select
                label={text('Project', '프로젝트')}
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
              <span aria-hidden="true">{text('Session', '세션')}</span>
              <Select
                label={text('Session', '세션')}
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
            {text('Request', '요청')}
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
              <span aria-hidden="true">{text('Repeat', '반복')}</span>
              <Select
                label={text('Repeat', '반복')}
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
                  { value: 'once', label: text('Once', '한 번') },
                  { value: 'daily', label: text('Daily', '매일') },
                  { value: 'weekly', label: text('Weekly', '매주') },
                ]}
              />
            </div>
            <label htmlFor={`${ids}-time`} className={labelClass}>
              {draft.rule.kind === 'once'
                ? text('UTC date and time', 'UTC 날짜와 시각')
                : text('Local time', '현지 시각')}
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
              {text('Time zone', '시간대')}
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
              <legend className="mb-1.5 text-caption text-muted-foreground">
                {text('Days', '요일')}
              </legend>
              <div className="flex flex-wrap gap-1">
                {(ko
                  ? ['일', '월', '화', '수', '목', '금', '토']
                  : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
                ).map((day, index) => {
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
              <span aria-hidden="true">{text('Model profile', '모델 프로필')}</span>
              <Select
                label={text('Model profile', '모델 프로필')}
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
              <span aria-hidden="true">{text('Execution', '실행 방식')}</span>
              <Select
                label={text('Execution', '실행 방식')}
                value={draft.request.mode}
                onValueChange={(value) =>
                  setDraft({ ...draft, request: { ...draft.request, mode: value } })
                }
                options={[
                  { value: 'mock' as const, label: text('Simulation', '시뮬레이션') },
                  {
                    value: 'live' as const,
                    label: text('Connected model', '연결된 모델'),
                    disabled: !live,
                  },
                ]}
              />
            </div>
            <div className={labelClass}>
              <span aria-hidden="true">{text('Permissions', '권한')}</span>
              <Select
                label={text('Permissions', '권한')}
                value={draft.request.permissionMode}
                onValueChange={(permissionMode) =>
                  setDraft({ ...draft, request: { ...draft.request, permissionMode } })
                }
                options={[
                  { value: 'ask' as const, label: 'Ask' },
                  { value: 'accept_edits' as const, label: 'Accept edits' },
                  { value: 'auto' as const, label: 'Auto' },
                ]}
              />
            </div>
          </div>
          <Switch
            label={text('Enable scheduled runs', '예약 실행 활성화')}
            checked={draft.enabled}
            onToggle={() => setDraft({ ...draft, enabled: !draft.enabled })}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} type="submit">
              {text('Save schedule', '예약 저장')}
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setDraft(null);
                setSelected(null);
              }}
            >
              {text('Close', '닫기')}
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
                  {text('Run now', '지금 실행')}
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
                  {text('Delete schedule', '예약 삭제')}
                </Button>
              </>
            ) : null}
          </div>
          {savedEnabled !== null && !dirty ? (
            <p role="status" className="text-sm">
              {t(savedEnabled ? 'savedEnabled' : 'savedDisabled')}
            </p>
          ) : null}
          {dirty ? (
            <p className="text-xs text-muted-foreground">
              {text(
                'Save changes before running this schedule.',
                '지금 실행하려면 변경 사항을 먼저 저장하세요.',
              )}
            </p>
          ) : null}
        </form>
      ) : null}
      {selected && history.length ? (
        <section
          aria-label={text('Run history', '실행 기록')}
          className="border-t border-line pt-4"
        >
          <h3 className="mb-2 font-medium">{text('Run history', '실행 기록')}</h3>
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
                    {text('Open run / respond', '실행 열기 / 응답')}
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
