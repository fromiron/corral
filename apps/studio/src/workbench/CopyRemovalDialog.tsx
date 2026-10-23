import type { CopyRemovalPlan } from '@corral/client';
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

type Seen = { plan: CopyRemovalPlan; unsaved: string[]; recoveries: string[] };

/**
 * Removing a session's working copy (CR-046 P21-A) shows first what would be lost: unsaved
 * documents and recovery drafts in this browser, the copy's uncommitted Git changes, unsent review
 * comments, writes of unknown outcome and unfinished runs. A copy still held by a task, terminal
 * or run is not removed from here. Removal is for the copy generation shown, never a copy made
 * again since. Archiving a session is separate and never removes its copy.
 */
export function CopyRemovalDialog({
  open,
  sessionId,
  projectId,
  onClose,
  onRemoved,
}: {
  open: boolean;
  sessionId: string;
  projectId: string;
  onClose(): void;
  onRemoved(): void;
}) {
  const t = useTranslations('Files');
  const { workspaces, workspaceId } = useServices();
  const [seen, setSeen] = useState<Seen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !workspaces) return;
    let live = true;
    setSeen(null);
    setError(null);
    void (async () => {
      const plan = await workspaces.removalPlan(sessionId);
      const owner = documentStore(workspaces);
      const unsaved = Object.values(owner.getState().documents)
        .filter(
          (entry) =>
            entry.target.sessionId === sessionId &&
            (entry.dirty || entry.saving || entry.pendingSave),
        )
        .map((entry) => entry.path);
      const recoveries = workspaceId
        ? (await owner.sessionRecoveries({ hostId: workspaceId, projectId, sessionId })).map(
            (draft) => draft.path,
          )
        : [];
      if (live) setSeen({ plan, unsaved, recoveries });
    })().catch((failure: unknown) => {
      if (live) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => {
      live = false;
    };
  }, [open, workspaces, workspaceId, sessionId, projectId]);
  const remove = async () => {
    if (!seen || !workspaces) return;
    setBusy(true);
    setError(null);
    try {
      await workspaces.removeWorktree(sessionId, seen.plan.copyGeneration);
      onRemoved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const plan = seen?.plan;
  const git = plan?.git;
  const held = Boolean(plan?.owners.length);
  const owner = (entry: CopyRemovalPlan['owners'][number]) =>
    entry.kind === 'run'
      ? t('removalOwner.run')
      : entry.operation === 'task' || entry.operation === 'terminal'
        ? t(`removalOwner.${entry.operation}`)
        : t('removalOwner.other');
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
        <DialogTitle>{t('removalTitle')}</DialogTitle>
        <DialogDescription>{t('removeConfirm')}</DialogDescription>
        {!seen && !error ? <p role="status">{t('removalLoading')}</p> : null}
        {seen && plan ? (
          <ul className="flex flex-col gap-1.5 text-sm" data-testid="removal-plan">
            {held ? (
              <li className="text-danger">
                {t('removalHeld', { what: [...new Set(plan.owners.map(owner))].join(', ') })}
              </li>
            ) : null}
            {seen.unsaved.length ? (
              <li className="text-warning">
                {t('removalUnsaved', { count: seen.unsaved.length })}
                <span className="block font-mono text-xs">{seen.unsaved.join(', ')}</span>
              </li>
            ) : null}
            {seen.recoveries.length ? (
              <li className="text-warning">
                {t('removalRecovery', { count: seen.recoveries.length })}
                <span className="block font-mono text-xs">{seen.recoveries.join(', ')}</span>
              </li>
            ) : null}
            {git === null ? (
              <li className="text-warning">{t('removalGitUnknown')}</li>
            ) : git && git.staged + git.unstaged + git.untracked + git.unmerged > 0 ? (
              <li className="text-warning">
                {t('removalGit', {
                  staged: git.staged,
                  unstaged: git.unstaged,
                  untracked: git.untracked,
                })}
                {git.unmerged ? ` · ${t('removalUnmerged', { count: git.unmerged })}` : ''}
              </li>
            ) : null}
            {plan.draftComments ? (
              <li className="text-warning">
                {t('removalComments', { count: plan.draftComments })}
              </li>
            ) : null}
            {plan.uncertainWrites ? (
              <li className="text-warning">
                {t('removalUncertain', { count: plan.uncertainWrites })}
              </li>
            ) : null}
            {plan.openRuns.length ? (
              <li className="text-warning">{t('removalRuns', { count: plan.openRuns.length })}</li>
            ) : null}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('removalKeep')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !seen || held}
            onClick={() => void remove()}
          >
            {t('removeCopy')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
