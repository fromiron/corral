import type { WorkspaceTarget } from '@corral/contracts';
import { Button, Textarea } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { DocumentPanel } from './DocumentPanel.tsx';
import type { RecoveryDraft } from './documents/recovery.ts';
import { type DocumentStore, documentKey } from './documents/store.ts';
import type { FileReference } from './FilePanel.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

export function DockDocumentPanel({
  owner,
  target,
  path,
  viewId,
  onReference,
}: {
  owner: DocumentStore;
  target: WorkspaceTarget;
  path: string;
  viewId: string;
  onReference?: (reference: FileReference) => void;
}) {
  const key = documentKey(target, path);
  const entry = useStore(owner, (state) => state.documents[key]);
  const t = useTranslations('Documents');
  const td = useTranslations('Desktop');
  const tf = useTranslations('Files');
  const [revision, retry] = useState(0);
  const [read, setRead] = useState({
    key,
    pending: true,
    stale: false,
    error: null as string | null,
  });
  const [recoveries, setRecoveries] = useState<RecoveryDraft[]>([]);
  const [recoveryError, setRecoveryError] = useState(false);
  useEffect(() => {
    const refresh = () => retry((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    return () => window.removeEventListener(WORKSPACE_CHANGED, refresh);
  }, []);
  useEffect(() => {
    void revision;
    let live = true;
    setRead({ key, pending: true, stale: false, error: null });
    setRecoveries([]);
    setRecoveryError(false);
    const readRecovery = async () => {
      try {
        const candidates = await owner.sessionRecoveries({
          hostId: target.hostId,
          projectId: target.projectId,
          sessionId: target.sessionId,
        });
        if (live) setRecoveries(candidates.filter((candidate) => candidate.documentKey === key));
      } catch {
        if (live) setRecoveryError(true);
      }
    };
    void owner.open(target.sessionId, path).then(
      async (openedKey) => {
        if (!live) return;
        const stale = openedKey !== key;
        setRead({ key, pending: false, stale, error: null });
        if (stale) await readRecovery();
      },
      async (error: unknown) => {
        if (!live) return;
        setRead({
          key,
          pending: false,
          stale: false,
          error: error instanceof Error ? error.message : String(error),
        });
        await readRecovery();
      },
    );
    return () => {
      live = false;
    };
  }, [owner, key, path, target.hostId, target.projectId, target.sessionId, revision]);
  const state = read.key === key ? read : { pending: true, stale: false, error: null };
  const stale =
    state.stale ||
    Boolean(entry?.conflict && documentKey(entry.conflict.target, entry.conflict.path) !== key);
  const showEditor =
    entry &&
    (entry.file.content.kind === 'text' ||
      entry.dirty ||
      entry.pendingSave ||
      entry.recoveries.length);
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-auto p-3"
      data-testid="dock-document-panel"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <p className="min-w-0 flex-1 break-all font-medium" title={path}>
          {path}
        </p>
        {!onReference ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: target.sessionId }}
            title={target.sessionId}
            className="text-accent underline"
          >
            {t('openConversation')}
          </Link>
        ) : null}
      </div>
      {stale || state.error ? (
        <div className="space-y-2">
          <p role="alert" className="break-words text-xs text-danger">
            {stale ? t('staleDock') : state.error}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={state.pending}
            onClick={() => retry((value) => value + 1)}
          >
            {t('refresh')}
          </Button>
        </div>
      ) : null}
      {showEditor ? (
        <DocumentPanel
          owner={owner}
          documentKey={key}
          viewId={viewId}
          onReference={onReference}
          readOnlyTarget={stale || Boolean(state.error)}
          manageView={false}
          referencePending={state.pending}
          fill
        />
      ) : state.pending ? (
        <p role="status" className="text-xs text-muted">
          {t('loading')}
        </p>
      ) : entry ? (
        <p className="text-xs text-muted">
          {entry.file.content.kind === 'binary'
            ? tf('binary')
            : entry.file.content.kind === 'too_large'
              ? tf('tooLarge')
              : td('fileUnavailable')}
        </p>
      ) : null}
      {recoveries
        .filter((candidate) => !entry || candidate.text !== entry.text)
        .map((candidate) => (
          <section
            key={candidate.id}
            aria-label={t('recovery')}
            className="min-w-0 space-y-2 rounded fill-group p-3"
          >
            <p className="text-xs text-muted">{t('previousCopyHint')}</p>
            <Textarea
              readOnly
              aria-label={t('draftContent')}
              value={candidate.text}
              className="font-mono text-xs"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void owner
                  .discardRecoveryCandidate(candidate)
                  .then(() => retry((value) => value + 1))
                  .catch(() => setRecoveryError(true));
              }}
            >
              {t('discardRecovery')}
            </Button>
          </section>
        ))}
      {recoveryError ? (
        <p role="alert" className="text-xs text-danger">
          {t('recoveryReadFailed')}
        </p>
      ) : null}
    </div>
  );
}
