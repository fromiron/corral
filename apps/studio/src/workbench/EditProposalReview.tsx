import type { WorkspacesApi } from '@corral/client';
import {
  canonicalJson,
  type FileEditOperation,
  type FileEditProposal,
  type FileEditProposalSummary,
  type WorkspaceTarget,
} from '@corral/contracts';
import { Button, Dialog, DialogDescription, DialogPopup, DialogTitle } from '@corral/react/ui';
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import type { DocumentBuffer, DocumentStore } from './documents/store.ts';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const FileDiff = lazy(() =>
  import('../pages/ReviewPage.tsx').then((module) => ({ default: module.FileDiff })),
);

export type FileEditClient = Pick<
  WorkspacesApi,
  | 'fileEditProposals'
  | 'fileEditProposal'
  | 'applyFileEdits'
  | 'dismissFileEdits'
  | 'inverseFileEdits'
  | 'fileEditOperation'
  | 'reconcileFileEdits'
  | 'languageState'
>;
interface Props {
  api: FileEditClient;
  owner: DocumentStore;
  target: WorkspaceTarget;
  proposal?: FileEditProposal | null;
  onConsumed?(): void;
}
const unsafe = (entry: DocumentBuffer) =>
  entry.dirty || entry.saving || entry.pendingSave !== null || entry.conflict !== null;

export function EditProposals(props: Props) {
  return <ProposalReview key={canonicalJson(props.target)} {...props} />;
}

function ProposalReview({ api, owner, target, proposal, onConsumed }: Props) {
  const t = useTranslations('EditProposals');
  const scope = canonicalJson(target);
  const { documents } = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FileEditProposalSummary[]>([]);
  const [detail, setDetail] = useState<FileEditProposal | null>(null);
  const [operation, setOperation] = useState<FileEditOperation | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const current = useRef({ api, owner });
  current.current = { api, owner };
  useEffect(
    () => () => {
      ++epoch.current;
    },
    [],
  );
  const isCurrent = (revision: number) =>
    revision === epoch.current && current.current.api === api && current.current.owner === owner;
  const matches = (value: FileEditProposalSummary) => canonicalJson(value.target) === scope;
  const validProposal = (value: FileEditProposal, expected?: FileEditProposalSummary) => {
    if (
      !matches(value) ||
      (expected && (value.proposalId !== expected.proposalId || value.hash !== expected.hash))
    )
      throw new Error(t('stale'));
  };
  const validOperation = (value: FileEditOperation, source: FileEditProposal, id: string) => {
    if (
      canonicalJson(value.target) !== scope ||
      value.operationId !== id ||
      value.result.proposalId !== source.proposalId ||
      value.result.proposalHash !== source.hash
    )
      throw new Error(t('stale'));
  };
  const affected = (source: FileEditProposal, entry: DocumentBuffer) =>
    canonicalJson(entry.target) === scope &&
    (source.files.some((file) => file.path === entry.path) ||
      (source.source.kind === 'language' && source.source.language.path === entry.path));
  const blocked =
    detail && Object.values(documents).some((entry) => affected(detail, entry) && unsafe(entry));
  const protectDrafts = (source: FileEditProposal) => {
    if (
      Object.values(owner.getState().documents).some(
        (entry) => affected(source, entry) && unsafe(entry),
      )
    )
      throw new Error(t('drafts'));
  };
  const record = async (
    value: FileEditOperation,
    source: FileEditProposal,
    id: string,
    revision: number,
  ) => {
    validOperation(value, source, id);
    if (!isCurrent(revision)) return;
    setOperation(value);
    setOperationId(id);
    setDetail({ ...source, operationId: id });
    if (
      value.result.outcomes.some(
        (outcome) => outcome.state === 'applied' || outcome.state === 'uncertain',
      )
    ) {
      await Promise.allSettled(
        Object.values(owner.getState().documents)
          .filter((entry) => affected(source, entry) && !unsafe(entry))
          .map((entry) => owner.refresh(entry.key)),
      );
      if (isCurrent(revision)) window.dispatchEvent(new Event(WORKSPACE_CHANGED));
    }
  };
  const select = async (id: string, snapshot?: FileEditProposalSummary) => {
    const revision = ++epoch.current;
    setOpen(true);
    setDetail(null);
    setOperation(null);
    setOperationId(null);
    setError('');
    setBusy(true);
    try {
      const value = await api.fileEditProposal(target.sessionId, id);
      if (!isCurrent(revision)) return;
      validProposal(value, snapshot);
      if (value.proposalId !== id) throw new Error(t('stale'));
      setDetail(value);
      setPath(value.files[0]?.path ?? '');
      setOperationId(value.operationId);
      if (value.operationId) {
        const result = await api.fileEditOperation(target.sessionId, value.operationId);
        await record(result, value, value.operationId, revision);
      }
    } catch (failure) {
      if (isCurrent(revision)) setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      if (isCurrent(revision)) setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: A supplied immutable proposal is an explicit request to open it.
  useEffect(() => {
    if (proposal) void select(proposal.proposalId, proposal);
  }, [proposal, api, owner]);
  const history = async () => {
    const revision = ++epoch.current;
    setOpen(true);
    setDetail(null);
    setOperation(null);
    setOperationId(null);
    setItems([]);
    setError('');
    setBusy(true);
    try {
      const values = await api.fileEditProposals(target.sessionId);
      if (isCurrent(revision)) setItems(values.filter(matches));
    } catch (failure) {
      if (isCurrent(revision)) setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      if (isCurrent(revision)) setBusy(false);
    }
  };
  const act = async (action: 'apply' | 'dismiss' | 'inverse' | 'check' | 'reconcile') => {
    if (!detail || busy) return;
    const revision = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      if (action === 'apply' || action === 'inverse') protectDrafts(detail);
      const fresh = await api.fileEditProposal(target.sessionId, detail.proposalId);
      if (!isCurrent(revision)) return;
      validProposal(fresh, detail);
      setDetail(fresh);
      const id = fresh.operationId ?? operationId;
      if (action === 'apply' && !id) {
        if (fresh.dismissed) throw new Error(t('stale'));
        if (fresh.source.kind === 'language') {
          const language = await api.languageState(target.sessionId);
          if (!isCurrent(revision)) return;
          const source = fresh.source.language;
          if (
            canonicalJson(language.target) !== scope ||
            language.session?.state !== 'running' ||
            language.session.generation !== source.generation ||
            language.session.clientId !== source.clientId ||
            language.session.serverId !== source.serverId ||
            language.session.configRevision !== source.configRevision ||
            language.session.fingerprint !== source.fingerprint
          )
            throw new Error(t('stale'));
        }
        protectDrafts(fresh);
        // The immutable hash keeps a lost response on the same command after reopening or reloading.
        const nextId = `file_edit_${fresh.hash}`;
        setOperationId(nextId);
        const result = await api.applyFileEdits(target.sessionId, fresh.proposalId, {
          target,
          proposalHash: fresh.hash,
          operationId: nextId,
        });
        await record(result, fresh, nextId, revision);
      } else if (action === 'dismiss') {
        if (id) throw new Error(t('stale'));
        const result = await api.dismissFileEdits(target.sessionId, fresh.proposalId, {
          target,
          proposalHash: fresh.hash,
        });
        if (!isCurrent(revision)) return;
        validProposal(result, fresh);
        setDetail(result);
      } else if (action === 'inverse') {
        if (!id || !operation?.result.outcomes.some((outcome) => outcome.state === 'applied'))
          throw new Error(t('stale'));
        validOperation(operation, fresh, id);
        protectDrafts(fresh);
        const inverse = await api.inverseFileEdits(target.sessionId, fresh.proposalId, {
          target,
          proposalHash: fresh.hash,
          operationId: id,
          requestId: `inverse_${fresh.hash}`,
        });
        if (!isCurrent(revision)) return;
        validProposal(inverse);
        if (
          inverse.source.kind !== 'inverse' ||
          inverse.source.proposalId !== fresh.proposalId ||
          inverse.source.operationId !== id
        )
          throw new Error(t('stale'));
        setDetail(inverse);
        setPath(inverse.files[0]?.path ?? '');
        setOperation(null);
        setOperationId(inverse.operationId);
      } else {
        if (!id) throw new Error(t('stale'));
        const result =
          action === 'reconcile'
            ? await api.reconcileFileEdits(target.sessionId, { target, operationId: id })
            : await api.fileEditOperation(target.sessionId, id);
        await record(result, fresh, id, revision);
      }
    } catch (failure) {
      if (isCurrent(revision)) setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      if (isCurrent(revision)) setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    ++epoch.current;
    setOpen(false);
    onConsumed?.();
  };
  const file = detail?.files.find((file) => file.path === path);
  const state = detail?.dismissed
    ? 'dismissed'
    : (operation?.state ?? (operationId ? 'unconfirmed' : 'pending'));
  const partial =
    operation?.result.outcomes.some((outcome) => outcome.state === 'applied') &&
    operation.result.outcomes.some((outcome) => outcome.state !== 'applied');
  return (
    <>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void history()}>
        {t('history')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogPopup
          showCloseButton={false}
          className="flex w-[min(95vw,1000px)] max-w-[1000px] flex-col gap-3 overflow-auto p-5"
        >
          <DialogTitle>{detail?.title ?? t('history')}</DialogTitle>
          <DialogDescription>{t('hint')}</DialogDescription>
          {error || operation?.result.error ? (
            <p role="alert" className="text-sm text-danger">
              {error || operation?.result.error?.message}
            </p>
          ) : null}
          {busy ? (
            <p role="status" className="text-sm text-muted">
              {t('busy')}
            </p>
          ) : null}
          {detail ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span role="status">{t(`states.${state}`)}</span>
                <span>{t(`sources.${detail.source.kind}`)}</span>
                <span className="font-mono" title={detail.hash}>
                  {detail.hash.slice(0, 12)}
                </span>
              </div>
              <ul
                aria-label={t('files')}
                className="flex max-h-36 shrink-0 flex-col gap-1 overflow-auto"
              >
                {detail.files.map((value) => (
                  <li key={value.path}>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-pressed={path === value.path}
                      className="max-w-full justify-start"
                      onClick={() => setPath(value.path)}
                    >
                      <span className="min-w-0 truncate font-mono">{value.path}</span>
                      <span>
                        {t(
                          `outcomes.${operation?.result.outcomes.find((outcome) => outcome.path === value.path)?.state ?? 'pending'}`,
                        )}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
              {file ? (
                <Suspense fallback={<p className="text-xs text-muted">{t('busy')}</p>}>
                  <FileDiff
                    path={file.path}
                    loadKey={`${detail.hash}:${file.path}`}
                    load={async () => ({
                      before: { kind: 'text', text: file.before },
                      after: { kind: 'text', text: file.after },
                    })}
                  />
                </Suspense>
              ) : null}
              {blocked ? (
                <p role="alert" className="text-sm text-warning">
                  {t('drafts')}
                </p>
              ) : null}
              {partial || operation?.state === 'uncertain' ? (
                <p className="text-sm text-warning">{t('partial')}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {!operationId && !detail.dismissed ? (
                  <>
                    <Button disabled={busy || !!blocked} onClick={() => void act('apply')}>
                      {t('apply')}
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => void act('dismiss')}>
                      {t('dismiss')}
                    </Button>
                  </>
                ) : null}
                {operationId ? (
                  <Button variant="outline" disabled={busy} onClick={() => void act('check')}>
                    {t('check')}
                  </Button>
                ) : null}
                {operationId &&
                (!operation || operation.state === 'uncertain' || operation.state === 'running') ? (
                  <Button variant="outline" disabled={busy} onClick={() => void act('reconcile')}>
                    {t('reconcile')}
                  </Button>
                ) : null}
                {operation?.result.outcomes.some((outcome) => outcome.state === 'applied') ? (
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      !!blocked ||
                      operation.state === 'running' ||
                      operation.state === 'uncertain'
                    }
                    onClick={() => void act('inverse')}
                  >
                    {t('inverse')}
                  </Button>
                ) : null}
                <Button variant="ghost" disabled={busy} onClick={() => void history()}>
                  {t('back')}
                </Button>
              </div>
            </>
          ) : !busy ? (
            <ul className="flex flex-col gap-2">
              {items.length ? (
                items.map((value) => (
                  <li key={value.proposalId}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void select(value.proposalId, value)}
                    >
                      {value.title}
                    </Button>
                    <p className="text-xs text-muted">
                      {t(
                        value.dismissed
                          ? 'states.dismissed'
                          : value.operationId
                            ? 'hasOperation'
                            : 'states.pending',
                      )}{' '}
                      · {value.files.length}
                    </p>
                  </li>
                ))
              ) : (
                <li className="text-sm text-muted">{t('empty')}</li>
              )}
            </ul>
          ) : null}
          <div className="flex justify-end">
            <Button variant="ghost" disabled={busy} onClick={close}>
              {t('close')}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
