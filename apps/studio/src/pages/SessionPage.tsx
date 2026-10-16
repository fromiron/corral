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
import { type KeyboardEvent, useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { projectName, setCurrentProject } from '../projects.ts';
import { sessionRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { WorkingCopyPanel } from './FilesViews.tsx';

// A work session (CR-011, roadmap 23–24): what was asked, the runs it started, the queue, and
// one input box whose intent is chosen, never guessed.

const newCommandId = () => `cmd_${globalThis.crypto.randomUUID()}`;

/** The session's runs, kept current while one is working. */
function useSessionRuns(sessionId: string) {
  const { transport } = useServices();
  const [all, setAll] = useState<RunSummary[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    void tick;
    let live = true;
    transport.listRuns().then(
      (runs) => live && setAll(runs),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [transport, tick]);
  const active = all.find((r) => !TERMINAL_RUN_STATUSES.has(r.status)) ?? null;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [active, refresh]);
  const runs = all.filter((r) => r.sessionId === sessionId).reverse();
  return { runs, active, refresh };
}

export function SessionPage() {
  const t = useTranslations('Sessions');
  const tp = useTranslations('Projects');
  const { session, project, corrals } = sessionRoute.useLoaderData();
  const { runs, active, refresh } = useSessionRuns(session.sessionId);
  useEffect(() => setCurrentProject(session.projectId), [session.projectId]);
  const team = corrals.find((c) => c.corralId === session.corralId) ?? null;

  // Entries in order; runs that no entry names (started elsewhere) are shown after them.
  const named = new Set(session.entries.flatMap((e) => (e.runId ? [e.runId] : [])));
  const loose = runs.filter((r) => !named.has(r.runId));
  const queued = session.entries.filter((e) => e.state === 'queued');

  return (
    <main className="mx-auto flex h-full max-w-4xl flex-col gap-3 overflow-auto p-6">
      <Link
        to="/projects/$projectId"
        params={{ projectId: session.projectId }}
        className="text-xs underline"
      >
        {t('backTo', { name: projectName(project ?? undefined, tp('defaultName')) })}
      </Link>
      <SessionHeader session={session} corrals={corrals} team={team} />
      <WorkingCopyPanel sessionId={session.sessionId} projectId={session.projectId} />
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
        onChange={refresh}
      />
    </main>
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
function RunCard({ run, nested = false }: { run: RunSummary; nested?: boolean }) {
  const t = useTranslations('Sessions');
  const { transport } = useServices();
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
  return (
    <section
      aria-label={run.runId}
      data-testid={`run-card-${run.runId}`}
      className={`flex flex-col gap-2 ${nested ? 'border-t border-line pt-2' : 'rounded-lg border border-line bg-raised p-3'}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge status={run.status} />
        <span className="font-mono text-muted">{run.runId}</span>
        <Link
          to="/runs/$runId"
          params={{ runId: run.runId }}
          search={{ view: 'results' }}
          className="underline"
        >
          {t('openResults')}
        </Link>
        <Link
          to="/runs/$runId"
          params={{ runId: run.runId }}
          search={{ view: 'run' }}
          className="underline"
        >
          {t('openRun')}
        </Link>
      </div>
      {!ended ? <p className="text-xs text-muted">{t('working')}</p> : null}
      {result ? (
        <div className="max-h-72 overflow-auto rounded border border-line bg-surface p-2">
          <SafeMarkdown text={result.text} />
        </div>
      ) : null}
    </section>
  );
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
  const ownActive = active && active.sessionId === session.sessionId ? active : null;
  const latest = useLatestResult(runs);

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
  }, [transport, ownActive]);
  const steerTarget = targets.some((x) => x.id === target) ? target : (targets[0]?.id ?? '');

  const record = async (entry: Parameters<typeof repository.addSessionEntry>[1]) => {
    const saved = await repository.addSessionEntry(session.sessionId, entry);
    if (!saved.ok) setError(t('failed', { message: saved.message }));
  };

  /** Starts a follow-up with the team; returns the run or why not. */
  const startNext = async (
    brief: string,
  ): Promise<{ runId: string | null; detail: string | null }> => {
    if (!team) return { runId: null, detail: t('noTeamYet') };
    const corral = await repository.get(team.corralId);
    if (!corral) return { runId: null, detail: t('noTeamYet') };
    const input = { brief, criteria: corral.definition.input.criteria };
    const common = {
      schemaVersion: '0.1' as const,
      commandId: newCommandId(),
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
        const { runId, detail } = await startNext(body);
        await record({ intent, text: body, state: runId ? 'started' : 'refused', runId, detail });
      } else if (intent === 'queue') {
        await record({ intent, text: body, state: 'queued' });
      } else if (intent === 'steer' && ownActive && steerTarget) {
        const receipt = await transport.sendCommand({
          schemaVersion: '0.1',
          commandId: newCommandId(),
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
        });
      } else if (intent === 'explain') {
        const corral = team ? await repository.get(team.corralId) : null;
        const profile = corral?.definition.roles[0]?.modelProfile ?? 'model-a';
        if (!latest) {
          setError(t('noResult'));
          return;
        }
        const result = await services.startExplain({
          commandId: newCommandId(),
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
                  onClick={() => void removeQueued(entry)}
                  className="rounded border border-line px-2 py-0.5 text-xs"
                >
                  {t('remove')}
                </button>
              </li>
            ))}
          </ul>
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
