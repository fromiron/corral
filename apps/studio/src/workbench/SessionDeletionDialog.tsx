import { ApiError, type CopyRemovalPlan, type SessionDeletionSummary } from '@corral/client';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from '@corral/react/design-kit';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { documentStore } from './documents/store.ts';
import { readComposerDraft } from './sessionDraft.ts';
import { clearDeletedSessionLocal, sessionHandoffDraftCount } from './sessionLocal.ts';

type Seen = {
  summary: SessionDeletionSummary;
  unsaved: string[];
  recoveries: string[];
  composerDraft: boolean;
  handoffDrafts: number;
};

/**
 * Deleting a session lists what would be lost, then removes only that session.
 * Unfinished runs are stopped through the existing cancel command first. A working copy uses the
 * same generation check as removing the copy on its own. A confirmed delete that finds the
 * session already gone is done.
 */
export function SessionDeletionDialog({
  open,
  sessionId,
  projectId,
  onClose,
  onDeleted,
}: {
  open: boolean;
  sessionId: string;
  projectId: string;
  onClose(): void;
  onDeleted(): void;
}) {
  const t = useTranslations('Sessions');
  const files = useTranslations('Files');
  const { sessionDeletion, workspaces, workspaceId, transport } = useServices();
  const [seen, setSeen] = useState<Seen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !sessionDeletion) return;
    let live = true;
    setSeen(null);
    setError(null);
    void load(sessionDeletion, workspaces, workspaceId, sessionId, projectId)
      .then((next) => {
        if (live) setSeen(next);
      })
      .catch((failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      live = false;
    };
  }, [open, sessionDeletion, workspaces, workspaceId, sessionId, projectId]);
  if (!sessionDeletion) return null;
  const summary = seen?.summary;
  const plan = summary?.workingCopy;
  const held = Boolean(plan?.owners.length);
  const unfinished = summary?.unfinishedRunIds.length ?? 0;
  const finish = async () => {
    try {
      if (workspaces) await documentStore(workspaces).forgetSession(sessionId);
    } catch {
      // The session is already gone. This browser still drops what it can.
    }
    clearDeletedSessionLocal(sessionId);
    onDeleted();
  };
  const stop = async () => {
    if (!seen) return;
    setBusy(true);
    setError(null);
    try {
      for (const runId of seen.summary.unfinishedRunIds) {
        await transport.sendCommand({
          schemaVersion: '0.1',
          commandId: `cmd_${crypto.randomUUID()}`,
          runId,
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
        });
      }
      setSeen(await load(sessionDeletion, workspaces, workspaceId, sessionId, projectId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!seen) return;
    setBusy(true);
    setError(null);
    try {
      await sessionDeletion.delete(sessionId, {
        expectedRevision: seen.summary.revision,
        ...(seen.summary.workingCopy
          ? { copyGeneration: seen.summary.workingCopy.copyGeneration }
          : {}),
      });
      await finish();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) {
        await finish();
        return;
      }
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="flex flex-col gap-4 p-6"
      >
        <DialogTitle>{t('deleteTitle')}</DialogTitle>
        <DialogDescription>{t('deleteExplain')}</DialogDescription>
        {!seen && !error ? <p role="status">{t('deleteLoading')}</p> : null}
        {seen && summary ? (
          <ul className="flex flex-col gap-1.5 text-body" data-testid="session-deletion">
            <li>{t('deleteRuns', { count: summary.runs })}</li>
            <li>{t('deleteMessages', { count: summary.messages })}</li>
            <li>{t('deleteMedia', { count: summary.generatedMedia })}</li>
            {summary.inputImages ? (
              <li>{t('deleteInputImages', { count: summary.inputImages })}</li>
            ) : null}
            <li>
              {summary.schedules.length
                ? t('deleteSchedules', {
                    titles: summary.schedules.map((item) => item.title).join(', '),
                  })
                : t('deleteNoSchedules')}
            </li>
            <li>{t('deleteHandoffs', { count: summary.handoffs.length })}</li>
            {unfinished ? (
              <li className="text-danger">{t('deleteUnfinished', { count: unfinished })}</li>
            ) : null}
            {plan ? <CopyLosses plan={plan} files={files} /> : null}
            {seen.unsaved.length ? (
              <li className="text-warning">
                {files('removalUnsaved', { count: seen.unsaved.length })}
                <span className="block font-mono text-caption">{seen.unsaved.join(', ')}</span>
              </li>
            ) : null}
            {seen.recoveries.length ? (
              <li className="text-warning">
                {files('removalRecovery', { count: seen.recoveries.length })}
                <span className="block font-mono text-caption">{seen.recoveries.join(', ')}</span>
              </li>
            ) : null}
            {seen.composerDraft ? <li className="text-warning">{t('deleteDraft')}</li> : null}
            {seen.handoffDrafts ? (
              <li className="text-warning">
                {t('deleteHandoffDraft', { count: seen.handoffDrafts })}
              </li>
            ) : null}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('deleteKeep')}
          </Button>
          {unfinished ? (
            <Button variant="tertiary" disabled={busy} onClick={() => void stop()}>
              {t('deleteStop')}
            </Button>
          ) : null}
          <Button
            variant="destructive"
            disabled={busy || !seen || held || unfinished > 0}
            onClick={() => void remove()}
          >
            {t('deleteConfirm')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function CopyLosses({
  plan,
  files,
}: {
  plan: CopyRemovalPlan;
  files: ReturnType<typeof useTranslations<'Files'>>;
}) {
  const git = plan.git;
  const owner = (entry: CopyRemovalPlan['owners'][number]) =>
    entry.kind === 'run'
      ? files('removalOwner.run')
      : entry.operation === 'task' || entry.operation === 'terminal'
        ? files(`removalOwner.${entry.operation}`)
        : files('removalOwner.other');
  return (
    <>
      {plan.owners.length ? (
        <li className="text-danger">
          {files('removalHeld', { what: [...new Set(plan.owners.map(owner))].join(', ') })}
        </li>
      ) : null}
      {git === null ? (
        <li className="text-warning">{files('removalGitUnknown')}</li>
      ) : git.staged + git.unstaged + git.untracked + git.unmerged > 0 ? (
        <li className="text-warning">
          {files('removalGit', {
            staged: git.staged,
            unstaged: git.unstaged,
            untracked: git.untracked,
          })}
          {git.unmerged ? ` · ${files('removalUnmerged', { count: git.unmerged })}` : ''}
        </li>
      ) : null}
      {plan.draftComments ? (
        <li className="text-warning">{files('removalComments', { count: plan.draftComments })}</li>
      ) : null}
      {plan.uncertainWrites ? (
        <li className="text-warning">
          {files('removalUncertain', { count: plan.uncertainWrites })}
        </li>
      ) : null}
    </>
  );
}

async function load(
  sessionDeletion: NonNullable<ReturnType<typeof useServices>['sessionDeletion']>,
  workspaces: ReturnType<typeof useServices>['workspaces'],
  workspaceId: string | undefined,
  sessionId: string,
  projectId: string,
): Promise<Seen> {
  const summary = await sessionDeletion.preview(sessionId);
  const owner = workspaces ? documentStore(workspaces) : null;
  const unsaved = owner
    ? Object.values(owner.getState().documents)
        .filter(
          (entry) =>
            entry.target.sessionId === sessionId &&
            (entry.dirty || entry.saving || entry.pendingSave),
        )
        .map((entry) => entry.path)
    : [];
  const recoveries =
    owner && workspaceId
      ? (await owner.sessionRecoveries({ hostId: workspaceId, projectId, sessionId })).map(
          (draft) => draft.path,
        )
      : [];
  return {
    summary,
    unsaved,
    recoveries,
    composerDraft: readComposerDraft(sessionId).text.trim().length > 0,
    handoffDrafts: sessionHandoffDraftCount(sessionId),
  };
}
