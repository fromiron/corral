import type { WorkspacesApi } from '@corral/client';
import {
  canonicalJson,
  type FileEditPreviewResult,
  type FileEditProposal,
  type LanguageSession,
} from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Input,
} from '@corral/react/ui';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { LanguageSelection } from '../documents/CodeEditorView.tsx';
import type { DocumentBuffer, DocumentStore } from '../documents/store.ts';
import { EditProposals, type FileEditClient } from '../EditProposalReview.tsx';
import { type LanguageEditScope, type LanguageStore, languageCopyKey } from './store.ts';

const identityOf = (session: LanguageSession | null | undefined) =>
  session?.state === 'running'
    ? canonicalJson([
        session.generation,
        session.clientId,
        session.serverId,
        session.configRevision,
        session.fingerprint,
      ])
    : '';
const unsafe = (document: DocumentBuffer | undefined) =>
  !document ||
  document.dirty ||
  document.saving ||
  Boolean(document.pendingSave || document.conflict);

export function RefactorActions({
  api,
  owner,
  entry,
  store,
  selection,
}: {
  api: Pick<WorkspacesApi, 'previewFileEdits'> & FileEditClient;
  owner: DocumentStore;
  entry: DocumentBuffer;
  store: LanguageStore;
  selection: LanguageSelection | null;
}) {
  const t = useTranslations('FileEdits');
  const nameId = useId();
  const copyKey = languageCopyKey(entry.target);
  const copy = useStore(store, (state) => state.copies[copyKey]);
  const document = useStore(owner, (state) => state.documents[entry.key]);
  const session = copy?.state?.session;
  const active =
    copy?.state?.available && session?.state === 'running' && session.clientId === store.clientId;
  const dirty = unsafe(document);
  const { model, editVersion, text, baseHash } = document ?? {};
  const identity = identityOf(session);
  const context = useMemo(
    () => ({
      api,
      owner,
      store,
      key: entry.key,
      copyKey,
      model,
      editVersion,
      text,
      baseHash,
      dirty,
      identity,
    }),
    [api, owner, store, entry.key, copyKey, model, editVersion, text, baseHash, dirty, identity],
  );
  const current = useRef(context);
  current.current = context;
  const pending = useRef<AbortController | null>(null);
  const retry = useRef<{ api: typeof api; input: string; id: string } | null>(null);
  const [busy, setBusy] = useState<typeof context | null>(null);
  const [rename, setRename] = useState<{
    context: typeof context;
    selection: LanguageSelection;
  } | null>(null);
  const [name, setName] = useState('');
  const [result, setResult] = useState<{
    context: typeof context;
    value: FileEditPreviewResult;
  } | null>(null);
  const [review, setReview] = useState<{
    context: typeof context;
    proposal: FileEditProposal;
  } | null>(null);
  const [error, setError] = useState<{ context: typeof context; message: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A document or session scope change cancels its in-flight preview.
  useEffect(() => () => pending.current?.abort(), [context]);
  const cancel = () => {
    pending.current?.abort();
    setBusy(null);
    setRename(null);
  };
  const prepare = async (kind: 'rename' | 'code_actions', selected: LanguageSelection) => {
    if (!active || !session || dirty || busy === context) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(context);
    setError(null);
    setResult(null);
    const valid = (scope?: LanguageEditScope) => {
      const now = owner.getState().documents[entry.key];
      return (
        current.current === context &&
        pending.current === controller &&
        !controller.signal.aborted &&
        now &&
        !unsafe(now) &&
        now.model === model &&
        now.editVersion === editVersion &&
        now.text === text &&
        now.baseHash === baseHash &&
        languageCopyKey(now.target) === copyKey &&
        identityOf(store.getState().copies[copyKey]?.state?.session) === identity &&
        (!scope || store.documentVersion(entry.key) === scope.version)
      );
    };
    try {
      const scope = await store.editScope(entry.key);
      if (
        !scope ||
        !valid(scope) ||
        languageCopyKey(scope.target) !== copyKey ||
        scope.path !== entry.path ||
        scope.generation !== session.generation ||
        scope.clientId !== store.clientId
      )
        throw new Error(t('changed'));
      const input =
        kind === 'rename'
          ? { ...scope, kind, position: selected.position, newName: name }
          : { ...scope, kind, range: selected.range };
      const signature = canonicalJson(input);
      if (retry.current?.api !== api || retry.current.input !== signature)
        retry.current = {
          api,
          input: signature,
          id: `file_edit_preview_${crypto.randomUUID().replaceAll('-', '')}`,
        };
      const value = await api.previewFileEdits(
        entry.target.sessionId,
        { ...input, requestId: retry.current.id },
        controller.signal,
      );
      if (!valid(scope)) throw new Error(t('changed'));
      const source = {
        generation: scope.generation,
        clientId: scope.clientId,
        serverId: session.serverId,
        configRevision: session.configRevision,
        fingerprint: session.fingerprint,
        path: scope.path,
        version: scope.version,
      };
      if (
        !value.proposals.every(
          (proposal) =>
            canonicalJson(proposal.target) === canonicalJson(scope.target) &&
            proposal.source.kind === 'language' &&
            proposal.source.operation === kind &&
            canonicalJson(proposal.source.language) === canonicalJson(source),
        )
      )
        throw new Error(t('changed'));
      setResult({ context, value });
      if (kind === 'rename' && value.proposals.length === 1 && value.proposals[0])
        setReview({ context, proposal: value.proposals[0] });
      setRename(null);
    } catch (failure) {
      if (current.current === context && !controller.signal.aborted)
        setError({ context, message: failure instanceof Error ? failure.message : t('failed') });
    } finally {
      if (current.current === context && pending.current === controller) setBusy(null);
    }
  };
  const choices = result?.context === context ? result.value : null;
  const renaming = rename?.context === context ? rename : null;
  const unavailable = [
    ...new Set(
      (choices?.unavailable ?? []).map((item) =>
        t('unsupported', { title: item.title, reason: t(`reason.${item.reason}`) }),
      ),
    ),
  ];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {active && session.capabilities.rename ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={dirty || !selection || busy === context}
            onClick={() => {
              if (!selection || dirty) return;
              setName('');
              setError(null);
              setRename({ context, selection });
            }}
          >
            {t('rename')}
          </Button>
        ) : null}
        {active && session.capabilities.codeActions ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={dirty || !selection || busy === context}
            onClick={() => {
              if (selection) void prepare('code_actions', selection);
            }}
          >
            {t('actions')}
          </Button>
        ) : null}
        {busy === context && !renaming ? (
          <Button size="xs" variant="ghost" onClick={cancel}>
            {t('cancel')}
          </Button>
        ) : null}
        <EditProposals
          api={api}
          owner={owner}
          target={entry.target}
          proposal={review?.context === context ? review.proposal : null}
          onConsumed={() => setReview(null)}
        />
      </div>
      {active && dirty ? (
        <p className="text-xs text-muted">{t('dirty')}</p>
      ) : active && !selection ? (
        <p className="text-xs text-muted">{t('selectSymbol')}</p>
      ) : null}
      {busy === context ? (
        <p role="status" className="text-xs text-muted">
          {t('previewing')}
        </p>
      ) : null}
      {error?.context === context ? (
        <p role="alert" className="text-xs text-danger">
          {error.message}
        </p>
      ) : null}
      {choices ? (
        <div className="flex flex-col gap-1">
          {choices.proposals.length ? (
            choices.proposals.map((proposal) => (
              <Button
                key={proposal.proposalId}
                size="xs"
                variant="outline"
                className="self-start"
                onClick={() => setReview({ context, proposal })}
              >
                {proposal.title}
              </Button>
            ))
          ) : (
            <p className="text-xs text-muted">{t('noActions')}</p>
          )}
          {unavailable.length ? (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer rounded py-1">
                {t('unsupportedCount', { count: unavailable.length })}
              </summary>
              <div className="flex max-h-40 flex-col gap-1 overflow-auto py-1">
                {unavailable.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={Boolean(renaming)}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <DialogPopup className="flex max-w-lg flex-col gap-3 p-6" showCloseButton={false}>
          <DialogTitle>{t('rename')}</DialogTitle>
          <DialogDescription>{t('savedOnly')}</DialogDescription>
          {renaming ? (
            <p className="break-all text-xs text-muted">
              {entry.path}:{renaming.selection.position.line + 1}:
              {renaming.selection.position.character + 1}
            </p>
          ) : null}
          <label htmlFor={nameId} className="text-sm">
            {t('newName')}
          </label>
          <Input
            id={nameId}
            value={name}
            maxLength={200}
            disabled={busy === context}
            onChange={(event) => setName(event.target.value)}
          />
          {error?.context === context ? (
            <p role="alert" className="text-xs text-danger">
              {error.message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={cancel}>
              {t('cancel')}
            </Button>
            <Button
              disabled={busy === context || !name.trim() || !renaming}
              onClick={() => {
                if (renaming) void prepare('rename', renaming.selection);
              }}
            >
              {t('previewRename')}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
