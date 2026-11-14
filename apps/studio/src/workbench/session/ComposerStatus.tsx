import type { CorralSummary, RunSummary, SessionIntent, WorkSession } from '@corral/core';
import { Button } from '@corral/react/design-kit';
import { Square } from '@corral/react/icons';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { WORKSPACE_CHANGED } from '../../pages/FilesViews.tsx';
import { useServices } from '../../services.tsx';
import { ComposerStats } from '../widgets/ComposerStats.tsx';

// The rows around the input that say what the next request is and what it would start with.

/**
 * The one-line status's lead: cancelling the pre-run auto choice. Where a message goes and how it
 * is sent are on the tool line (SendControls).
 */
export function ComposerHeader({
  choosingAuto,
  onCancelAuto,
}: {
  choosingAuto: boolean;
  onCancelAuto: () => void;
}) {
  const t = useTranslations('Sessions');
  return (
    <>
      {/* A live run's status and Cancel sit elsewhere; only the pre-run auto choice is cancelled here. */}
      {choosingAuto ? (
        <Button variant="tertiary" data-slot="composer-run-header" onClick={onCancelAuto}>
          <Square className="size-3.5 fill-current" />
          {t('cancelAutoChoice')}
        </Button>
      ) : null}
    </>
  );
}

/**
 * Below the input: one quiet line of session totals. That the runs are simulated is the header's
 * connection word alone (workbench.md). Why a request cannot be sent now follows as its own alert.
 */
export function ComposerStatus({
  runs,
  liveUnavailable,
  reasoningBlocked,
  error,
}: {
  runs: RunSummary[];
  liveUnavailable: boolean;
  reasoningBlocked: boolean;
  error: string | null;
}) {
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  return (
    <>
      <div
        data-testid="composer-footer"
        className="flex min-w-0 items-center gap-2 px-4 pt-1 text-micro text-muted-foreground empty:hidden"
      >
        <ComposerStats runs={runs} />
      </div>
      {liveUnavailable || reasoningBlocked ? (
        <div className="flex flex-col gap-1 px-4 pt-1 text-caption text-warning">
          {liveUnavailable ? <p role="alert">{tc('liveUnavailable')}</p> : null}
          {reasoningBlocked ? (
            <p role="status" data-testid="reasoning-not-supported">
              {tc('reasoningUnsupportedHint')}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 pt-1 text-caption text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * What the next run would start with, for assistive tech only: the team chip, the model chip
 * and the session's Files and Changes views already show it.
 */
export function PreRun({
  session,
  team,
  isAuto,
  runMode,
  intent,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  isAuto: boolean;
  runMode: 'mock' | 'live';
  intent: SessionIntent;
}) {
  if (intent !== 'next') return null;
  if (isAuto) return <AutoPreRunSummary session={session} mode={runMode} />;
  return team ? <PreRunSummary session={session} team={team} mode={runMode} /> : null;
}

/**
 * What the next run would start with: team, models, file work, limits and
 * mode, read from the saved team and the working copy, never guessed.
 */
function PreRunSummary({
  session,
  team,
  mode,
}: {
  session: WorkSession;
  team: CorralSummary;
  mode: 'mock' | 'live';
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
      const roles = record.definition.roles;
      const fileTools = roles.some((r) => r.allowedWorkTools.includes('write_file'));
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
    t,
  ]);
  return text ? (
    <span data-testid="pre-run" className="sr-only">
      {text}
    </span>
  ) : null;
}

/** Mode and file work for the next auto request. The team control says Auto, and the model menu says the model when one can be chosen. */
function AutoPreRunSummary({ session, mode }: { session: WorkSession; mode: 'mock' | 'live' }) {
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
  const files = copy ? t('filesCopy') : null;
  return (
    <span data-testid="pre-run" className="sr-only">
      {[files, modeLabel].filter(Boolean).join(' · ')}
    </span>
  );
}
