import { ApiError } from '@corral/client';
import {
  type AutoModelChoice,
  type MeetingHandoffReceipt,
  MeetingHandoffRequest,
  type MeetingView,
  RunStatus,
  TERMINAL_RUN_STATUSES,
  type UltraSelection,
} from '@corral/contracts';
import { activeMeetingDecision, type CorralSummary, type WorkSession } from '@corral/core';
import { Button, Select } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';
import { AutoModelMenu } from './AutoModelMenu.tsx';
import {
  autoChoiceFor,
  autoNotReady,
  autoReasoningUnsupported,
  sessionRunMode,
} from './autoChoice.ts';
import { readComposerDraft, serializeComposerDraft } from './sessionDraft.ts';
import { defaultUltraSelection, UltraModels } from './UltraModels.tsx';
import { useModelProfiles } from './useModels.ts';

const changed = 'corral:meeting-handoffs-changed';
const pendingKey = (sessionId: string, versionId: string) =>
  `corral:meeting-handoff:${sessionId}:${versionId}`;
function loadPending(key: string) {
  try {
    return (
      MeetingHandoffRequest.safeParse(JSON.parse(window.localStorage.getItem(key) ?? 'null'))
        .data ?? null
    );
  } catch {
    return null;
  }
}
function hasUnsentInput(sessionId: string) {
  try {
    // Refused storage cannot establish that the target composer is empty.
    void window.localStorage.length;
    return serializeComposerDraft(readComposerDraft(sessionId)) !== null;
  } catch {
    return true;
  }
}
const failureText = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

export function MeetingHandoff({
  session,
  decision,
  onChange,
}: {
  session: WorkSession;
  decision: NonNullable<MeetingView['decisions']>[number];
  onChange(): Promise<void>;
}) {
  const t = useTranslations('MeetingsHandoff');
  const tc = useTranslations('Composer');
  const services = useServices();
  const api = services.meetingHandoffs;
  const profiles = useModelProfiles();
  const key = pendingKey(session.sessionId, decision.versionId);
  const [pending, setPending] = useState(() => loadPending(key));
  const [open, setOpen] = useState(!!pending);
  const [targets, setTargets] = useState<WorkSession[]>([]);
  const [corrals, setCorrals] = useState<CorralSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState(
    pending?.target.kind === 'existing' ? pending.target.sessionId : 'new',
  );
  const [title, setTitle] = useState(
    pending?.target.kind === 'new' ? pending.target.title : decision.content.goal.slice(0, 120),
  );
  const [execution, setExecution] = useState(
    pending?.execution.kind === 'corral' ? pending.execution.corralId : 'auto',
  );
  const [savedChoice, setChoice] = useState<AutoModelChoice | null>(
    pending?.execution.kind === 'auto' ? pending.execution.choice : null,
  );
  const choice = autoChoiceFor(savedChoice, profiles);
  const mode = sessionRunMode(services.mode, services.live);
  const [quality, setQuality] = useState<'default' | 'ultra'>(
    pending?.execution.kind === 'auto' ? (pending.execution.qualityPreset ?? 'default') : 'default',
  );
  const [savedUltra, setUltra] = useState<UltraSelection | null>(
    pending?.execution.kind === 'auto' ? (pending.execution.ultra ?? null) : null,
  );
  const [modelMenu, setModelMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<MeetingHandoffReceipt | null>(null);
  const ultraProfiles = useMemo(
    () =>
      mode === 'mock'
        ? ['model-a', 'model-b'].map((profileId) => ({
            profileId,
            label: profileId,
            available: true,
            reasoningCapabilities: {
              providerDefault: true,
              levels: ['medium', 'high'] as ('medium' | 'high')[],
            },
          }))
        : profiles,
    [mode, profiles],
  );
  const ultra = savedUltra ?? defaultUltraSelection(choice.modelProfile, ultraProfiles);
  const autoBlocked =
    execution === 'auto' &&
    (autoNotReady(choice, profiles, mode) ||
      (quality !== 'ultra' && autoReasoningUnsupported(choice, profiles, mode)) ||
      (quality === 'ultra' &&
        (ultra.modelProfiles.length < 2 ||
          !ultra.modelProfiles.includes(choice.modelProfile) ||
          ultra.verifierProfile === choice.modelProfile)));
  useEffect(() => {
    if (!open || !api) return;
    let active = true;
    void Promise.all([
      services.repository.listSessions(session.projectId),
      services.repository.list(),
    ]).then(
      ([sessions, teams]) => {
        if (!active) return;
        setTargets(
          sessions.filter(
            (item) => item.projectId === session.projectId && !item.meeting && !item.archivedAt,
          ),
        );
        setCorrals(teams.filter((team) => team.projectId === session.projectId));
        setLoaded(true);
      },
      (failure) => {
        if (active) setError(failureText(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [api, open, services.repository, session.projectId]);
  const savePending = (request: MeetingHandoffRequest | null) => {
    setPending(request);
    try {
      if (request) window.localStorage.setItem(key, JSON.stringify(request));
      else window.localStorage.removeItem(key);
    } catch {
      /* In-memory identity remains locked until the receipt is resolved. */
    }
  };
  const accept = async (next: MeetingHandoffReceipt) => {
    setReceipt(next);
    if (next.state !== 'uncertain' && next.state !== 'starting') savePending(null);
    window.dispatchEvent(new Event(changed));
    await onChange();
  };
  const send = async (action: 'draft' | 'start') => {
    if (!api || busy) return;
    const request: MeetingHandoffRequest = pending ?? {
      commandId: newCommandId(),
      decisionVersionId: decision.versionId,
      target:
        target === 'new'
          ? { kind: 'new', title: title.trim() }
          : { kind: 'existing', sessionId: target },
      action,
      execution:
        execution === 'auto'
          ? {
              kind: 'auto',
              choice: quality === 'ultra' ? { modelProfile: choice.modelProfile } : choice,
              ...(quality === 'ultra' ? { qualityPreset: 'ultra', ultra } : {}),
            }
          : { kind: 'corral', corralId: execution },
      mode,
      targetHasDraft: target !== 'new' && hasUnsentInput(target),
    };
    setBusy(true);
    setError('');
    savePending(request);
    try {
      if (pending) {
        const found = await api.receipt(session.sessionId, request.commandId);
        if (found.handoff && !['starting', 'uncertain'].includes(found.handoff.state)) {
          await accept(found.handoff);
          return;
        }
        const targetId =
          found.handoff?.targetSessionId ??
          (request.target.kind === 'existing' ? request.target.sessionId : null);
        if (
          request.action === 'start' &&
          !request.targetHasDraft &&
          targetId &&
          hasUnsentInput(targetId)
        ) {
          setError(t('draftChanged'));
          return;
        }
      }
      try {
        await accept((await api.send(session.sessionId, request)).handoff);
      } catch (failure) {
        // A failed HTTP response can still mean the command was accepted.
        const found = await api.receipt(session.sessionId, request.commandId);
        if (found.handoff) await accept(found.handoff);
        else {
          if (failure instanceof ApiError && [400, 404, 422].includes(failure.status))
            savePending(null);
          setError(failureText(failure));
        }
      }
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  };
  if (!api) return <p className="text-muted-foreground">{t('serverRequired')}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div>
        <Button
          size="compact"
          variant="tertiary"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {t('open')}
        </Button>
      </div>
      {open ? (
        <div className="flex min-w-0 flex-col gap-3">
          <p className="text-muted-foreground">{t('scopeHint')}</p>
          <fieldset disabled={busy || !!pending} className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span>{t('target')}</span>
              <Select
                label={t('target')}
                value={target}
                disabled={busy || !!pending}
                onValueChange={setTarget}
                options={[
                  { value: 'new', label: t('newSession') },
                  ...targets.map((item) => ({ value: item.sessionId, label: item.title })),
                ]}
              />
            </div>
            {target === 'new' ? (
              <label className="flex flex-col gap-1">
                {t('title')}
                <input
                  className="rounded fill-control p-2"
                  maxLength={120}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
            ) : null}
            <div className="flex flex-col gap-1">
              <span>{t('execution')}</span>
              <Select
                label={t('execution')}
                value={execution}
                disabled={busy || !!pending}
                onValueChange={setExecution}
                options={[
                  { value: 'auto', label: t('auto') },
                  ...corrals.map((team) => ({ value: team.corralId, label: team.name })),
                ]}
              />
            </div>
            {execution === 'auto' ? (
              <>
                <AutoModelMenu
                  value={choice}
                  profiles={(ultraProfiles ?? []).filter(
                    (profile) =>
                      quality !== 'ultra' || ultra.modelProfiles.includes(profile.profileId),
                  )}
                  showReasoning
                  ultra={quality === 'ultra'}
                  disabled={busy || !!pending}
                  open={modelMenu}
                  onOpenChange={setModelMenu}
                  onChange={(next) => {
                    setChoice(next);
                    if (next.modelProfile !== choice.modelProfile)
                      setUltra(
                        quality === 'ultra'
                          ? {
                              ...ultra,
                              verifierProfile:
                                ultra.verifierProfile === next.modelProfile
                                  ? choice.modelProfile
                                  : ultra.verifierProfile,
                            }
                          : null,
                      );
                  }}
                />
                <Select
                  label={tc('qualityPreset')}
                  value={quality}
                  disabled={busy || !!pending}
                  onValueChange={setQuality}
                  options={[
                    { value: 'default', label: tc('qualityDefault') },
                    { value: 'ultra', label: tc('qualityUltra') },
                  ]}
                />
                {quality === 'ultra' ? (
                  <UltraModels
                    primary={choice.modelProfile}
                    profiles={ultraProfiles}
                    value={ultra}
                    onChange={setUltra}
                    disabled={busy || !!pending}
                  />
                ) : null}
              </>
            ) : null}
          </fieldset>
          <p className="text-muted-foreground">{t('draftHint')}</p>
          {autoBlocked ? (
            <p className="text-warning" role="status">
              {t('modelUnavailable')}
            </p>
          ) : null}
          {pending ? (
            <div>
              <p role="status">{t('pending')}</p>
              <Button
                size="compact"
                variant="tertiary"
                disabled={busy}
                onClick={() => void send(pending.action)}
              >
                {t('retry')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="compact"
                variant="tertiary"
                disabled={busy || !loaded || (target === 'new' && !title.trim()) || autoBlocked}
                onClick={() => void send('draft')}
              >
                {t('draft')}
              </Button>
              <Button
                size="compact"
                disabled={busy || !loaded || (target === 'new' && !title.trim()) || autoBlocked}
                onClick={() => void send('start')}
              >
                {t('start')}
              </Button>
            </div>
          )}
          {error ? (
            <p className="text-danger wrap-anywhere" role="alert">
              {error}
            </p>
          ) : null}
          {receipt ? (
            <p role="status">
              {t(`state.${receipt.state}`)}{' '}
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: receipt.targetSessionId }}
                className="underline"
              >
                {t('targetLink')}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Both ends read the same receipt; work sessions keep a source link even for draft-only handoff. */
export function MeetingHandoffLinks({
  sessionId,
  onRediscuss,
  meeting,
}: {
  sessionId: string;
  meeting?: MeetingView;
  onRediscuss?(): Promise<void>;
}) {
  const services = useServices();
  const api = services.meetingHandoffs;
  const t = useTranslations('MeetingsHandoff');
  const [receipts, setReceipts] = useState<MeetingHandoffReceipt[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionCommands, setActionCommands] = useState<
    Record<string, { commandId: string; targetHasDraft: boolean }>
  >({});
  useEffect(() => {
    if (!api) return;
    let active = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api.list(sessionId);
        if (active) setReceipts(result.handoffs);
      } catch (failure) {
        if (active) setError(failureText(failure));
      } finally {
        loading = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3000);
    window.addEventListener(changed, refresh);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener(changed, refresh);
    };
  }, [api, sessionId]);
  const actOn = async (
    receipt: MeetingHandoffReceipt,
    action: 'cancel' | 'rediscuss' | 'start',
  ) => {
    if (!api || busy) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'cancel') await api.cancel(receipt.sourceSessionId, receipt.commandId);
      else {
        const actionKey = `${action}:${receipt.commandId}`;
        const command = actionCommands[actionKey] ?? {
          commandId: newCommandId(),
          targetHasDraft: hasUnsentInput(receipt.targetSessionId),
        };
        setActionCommands((current) => ({ ...current, [actionKey]: command }));
        if (action === 'start') {
          const found = await api.receipt(receipt.sourceSessionId, receipt.commandId);
          if (found.handoff && ['drafted', 'starting', 'uncertain'].includes(found.handoff.state)) {
            if (!command.targetHasDraft && hasUnsentInput(receipt.targetSessionId)) {
              setError(t('draftChanged'));
              return;
            }
            const next = await api.start(receipt.sourceSessionId, receipt.commandId, command);
            window.dispatchEvent(new Event(changed));
            if (['starting', 'uncertain'].includes(next.handoff.state)) return;
          }
        } else {
          const result = await api.rediscuss(receipt.sourceSessionId, receipt.commandId, {
            commandId: command.commandId,
            mode: sessionRunMode(services.mode, services.live),
          });
          if (!result.ok) {
            setError(result.message);
            return;
          }
          await onRediscuss?.();
        }
        setActionCommands((current) => {
          const next = { ...current };
          delete next[actionKey];
          return next;
        });
      }
      window.dispatchEvent(new Event(changed));
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  };
  if (!api || (!receipts.length && !error)) return null;
  return (
    <section className="flex min-w-0 flex-col gap-3 text-sm" aria-label={t('history')}>
      <h2 className="font-medium">{t('history')}</h2>
      {receipts.map((receipt) => (
        <article
          key={receipt.commandId}
          className="flex min-w-0 flex-col gap-2 rounded fill-group p-3"
        >
          <p className="wrap-anywhere">
            {t('decisionVersion')}: {receipt.decisionVersionId} · {t(`state.${receipt.state}`)}
          </p>
          <p className="text-muted-foreground wrap-anywhere">
            {t('execution')}:{' '}
            {receipt.execution.kind === 'auto'
              ? `${t('auto')} · ${receipt.execution.choice.modelProfile}${receipt.execution.qualityPreset === 'ultra' ? ' · Ultra' : ''}`
              : `${receipt.execution.corralId} · ${receipt.definitionRevision}`}
          </p>
          {receipt.detail ? <p className="wrap-anywhere">{receipt.detail}</p> : null}
          <div className="flex flex-wrap gap-3">
            <Link
              to="/sessions/$sessionId"
              params={{
                sessionId:
                  receipt.sourceSessionId === sessionId
                    ? receipt.targetSessionId
                    : receipt.sourceSessionId,
              }}
              className="underline"
            >
              {t(receipt.sourceSessionId === sessionId ? 'targetLink' : 'sourceLink')}
            </Link>
            {receipt.runId ? (
              <Link to="/runs/$runId" params={{ runId: receipt.runId }} className="underline">
                {t('runLink')}
                {receipt.result ? ` · ${receipt.result.status}` : ''}
              </Link>
            ) : null}
            {receipt.runId && receipt.result?.artifactVersionId ? (
              <Link
                to="/runs/$runId"
                params={{ runId: receipt.runId }}
                search={{ view: 'results', result: receipt.result.artifactVersionId }}
                className="underline"
              >
                {t('resultLink')}
              </Link>
            ) : null}
          </div>
          {['drafted', 'starting', 'uncertain'].includes(receipt.state) &&
          (!meeting || activeMeetingDecision(meeting, receipt.decisionVersionId)) ? (
            <div>
              <Button
                size="compact"
                variant="tertiary"
                disabled={busy}
                onClick={() => void actOn(receipt, 'start')}
              >
                {t(receipt.state === 'drafted' ? 'startDraft' : 'retry')}
              </Button>
            </div>
          ) : null}
          {receipt.sourceSessionId === sessionId &&
          receipt.result &&
          TERMINAL_RUN_STATUSES.has(
            RunStatus.safeParse(receipt.result.status).data ?? 'created',
          ) ? (
            <div>
              <Button
                size="compact"
                variant="tertiary"
                disabled={busy}
                onClick={() => void actOn(receipt, 'rediscuss')}
              >
                {t('rediscuss')}
              </Button>
            </div>
          ) : null}
          {['starting', 'uncertain'].includes(receipt.state) ||
          (receipt.state === 'started' &&
            !TERMINAL_RUN_STATUSES.has(
              RunStatus.safeParse(receipt.result?.status).data ?? 'created',
            )) ? (
            <div>
              <Button
                size="compact"
                variant="ghost-destructive"
                disabled={busy}
                onClick={() => void actOn(receipt, 'cancel')}
              >
                {t('cancel')}
              </Button>
            </div>
          ) : null}
        </article>
      ))}
      {error ? (
        <p role="alert" className="text-danger wrap-anywhere">
          {error}
        </p>
      ) : null}
    </section>
  );
}
