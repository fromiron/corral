import type { CorralSummary, RunSummary, SessionIntent, WorkSession } from '@corral/core';
import { Button, Select } from '@corral/react/design-kit';
import { Square } from '@corral/react/icons';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { WORKSPACE_CHANGED } from '../../pages/FilesViews.tsx';
import { useServices } from '../../services.tsx';
import type { Blocked } from '../composerIntent.ts';
import { ComposerStats } from '../widgets/ComposerStats.tsx';

// The rows around the input that say what the next request is and what it would start with.

/**
 * The one-line status's lead: cancelling the pre-run auto choice, and what the request is and
 * for whom. The intent stays visible while idle, except on an empty session's home.
 */
export function ComposerHeader({
  choosingAuto,
  onCancelAuto,
  allowed,
  blocked,
  intent,
  onChooseIntent,
  steerTarget,
  targets,
  targetName,
  onChooseTarget,
  quiet = false,
}: {
  choosingAuto: boolean;
  onCancelAuto: () => void;
  allowed: SessionIntent[];
  blocked: Blocked;
  intent: SessionIntent;
  onChooseIntent: (value: SessionIntent) => void;
  steerTarget: string;
  targets: { id: string; label: string }[];
  targetName: (id: string) => string;
  onChooseTarget: (value: string) => void;
  /** An empty session has nothing to follow up yet. */
  quiet?: boolean;
}) {
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  return (
    <>
      {/* A live run's status and Cancel sit in the top bar; only the pre-run auto choice is cancelled here. */}
      {choosingAuto ? (
        <Button
          variant="tertiary"
          size="compact"
          data-slot="composer-run-header"
          onClick={onCancelAuto}
        >
          <Square className="size-3.5 fill-current" />
          {t('cancelAutoChoice')}
        </Button>
      ) : null}
      {allowed.length > 1 && !blocked ? (
        <Select
          variant="chip"
          label={t('intentLabel')}
          value={intent}
          onValueChange={onChooseIntent}
          options={allowed.map((value) => ({
            value,
            label: t(`intentShort.${value}`),
            hint: t(`intentHint.${value}`),
          }))}
        />
      ) : intent !== 'next' || blocked || !quiet ? (
        <span title={t(`intentHint.${intent}`)} className="px-2 text-ui text-muted-foreground">
          {t(`intentShort.${intent}`)}
        </span>
      ) : null}
      {intent === 'steer' ? (
        <Select
          variant="chip"
          label={t('target')}
          value={steerTarget || null}
          placeholder={t('noTarget')}
          onValueChange={onChooseTarget}
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
    </>
  );
}

/** Below the input: what the next request would start with, and why it cannot be sent now. */
export function ComposerStatus({
  session,
  runs,
  team,
  isAuto,
  runMode,
  intent,
  latest,
  lastEnded,
  liveUnavailable,
  reasoningBlocked,
  error,
}: {
  session: WorkSession;
  runs: RunSummary[];
  team: CorralSummary | null;
  isAuto: boolean;
  runMode: 'mock' | 'live';
  intent: SessionIntent;
  /** The newest final result, which a question is about. */
  latest: { runId: string; id: string; label: string } | null;
  /** The newest ended run, which a follow-up continues. */
  lastEnded: RunSummary | null;
  liveUnavailable: boolean;
  reasoningBlocked: boolean;
  error: string | null;
}) {
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  return (
    <>
      <div className="flex min-h-5 flex-wrap items-center gap-x-2 px-4 pt-1.5 text-2xs text-muted-foreground">
        <ComposerStats runs={runs} />
        {(intent === 'next' || intent === 'explain') && isAuto ? (
          <AutoPreRunSummary session={session} mode={runMode} intent={intent} />
        ) : null}
        {intent === 'explain' && !latest ? (
          <span className="text-warning">{t('noResult')}</span>
        ) : null}
        {(intent === 'next' || intent === 'explain') && team ? (
          <PreRunSummary session={session} team={team} mode={runMode} intent={intent} />
        ) : null}
        {intent === 'next' && lastEnded ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('continuesConversation')}</span>
          </>
        ) : null}
        {intent === 'explain' && latest ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('fromResult', { label: latest.label })}</span>
          </>
        ) : null}
        {intent === 'steer' ? <span>{t('intentHint.steer')}</span> : null}
        {intent === 'queue' ? <span>{t('intentHint.queue')}</span> : null}
      </div>
      {liveUnavailable || reasoningBlocked ? (
        <div className="flex flex-col gap-1 px-4 pt-1 text-caption text-warning">
          {liveUnavailable ? <p role="alert">{tc('liveUnavailable')}</p> : null}
          {reasoningBlocked ? (
            <p role="status" data-testid="reasoning-not-supported" className="text-warning">
              {tc('reasoningUnsupportedHint')}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 pt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * What the next run would start with: team, models, file work, limits and
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
      if (!live) return;
      setText(
        t('preRun', {
          team: `${record.name} r${record.definitionRevision}`,
          profiles: [...new Set(roles.map((r) => r.modelProfile))].join(', '),
          files: fileTools ? (copy ? t('filesCopy') : t('filesNoCopy')) : t('filesNone'),
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

/** Mode and file work for the next auto request. The team control says Auto, and the model menu says the model when one can be chosen. */
function AutoPreRunSummary({
  session,
  mode,
  intent,
}: {
  session: WorkSession;
  mode: 'mock' | 'live';
  intent: 'next' | 'explain';
}) {
  const t = useTranslations('Sessions');
  const { workspaces } = useServices();
  const [copy, setCopy] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  useEffect(() => {
    const changed = () => setWorkspaceRevision((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  useEffect(() => {
    void workspaceRevision;
    let live = true;
    void (workspaces?.worktree(session.sessionId) ?? Promise.resolve(null))
      .catch(() => null)
      .then((found) => live && setCopy(Boolean(found)));
    return () => {
      live = false;
    };
  }, [workspaces, session.sessionId, workspaceRevision]);
  const modeLabel = mode === 'live' ? t('modeLive') : t('modeMock');
  // Auto roles get file tools only with a working copy.
  const files = intent === 'next' && copy ? t('filesCopy') : null;
  return <span data-testid="pre-run">{[files, modeLabel].filter(Boolean).join(' · ')}</span>;
}
