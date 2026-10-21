import { Button, Input, Select, Textarea } from '@corral/react/ui';
import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { DocumentStore } from './documents/store.ts';
import type { FileReference } from './FilePanel.tsx';

const CodeEditorView = lazy(() =>
  import('./documents/CodeEditorView.tsx').then((module) => ({ default: module.CodeEditorView })),
);

export function DocumentPanel({
  owner,
  documentKey,
  viewId,
  onReference,
  readOnlyTarget = false,
}: {
  owner: DocumentStore;
  documentKey: string;
  viewId: string;
  onReference: (reference: FileReference) => void;
  readOnlyTarget?: boolean;
}) {
  const entry = useStore(owner, (state) => state.documents[documentKey]);
  const t = useTranslations('Documents');
  const td = useTranslations('Desktop');
  const rangeId = useId();
  const [range, setRange] = useState({ start: 1, end: 1 });
  const [revealRange, setRevealRange] = useState<{ startLine: number; endLine: number }>();
  const [editorFailed, setEditorFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => owner.retainView(documentKey, viewId), [owner, documentKey, viewId]);
  if (!entry) return null;
  const lineCount = entry.text.split(/\r\n|\r|\n/).length;
  const validRange = range.start >= 1 && range.end >= range.start && range.end <= lineCount;
  const pending = Boolean(entry.pendingSave);
  const canSave =
    !entry.saving &&
    (pending
      ? entry.canRetrySave
      : !readOnlyTarget &&
        entry.file.writable &&
        !entry.conflict &&
        !entry.formatBlocked &&
        entry.dirty);
  const canReference = !readOnlyTarget && validRange && !entry.dirty && !entry.saving && !pending;
  const perform = (work: () => Promise<unknown>) => {
    setActionError(null);
    void work().catch(() => setActionError(t('operationFailed')));
  };
  const save = async () => {
    if (!canSave) return;
    setActionError(null);
    if (!(await owner.save(documentKey))) setActionError(t('saveFailed'));
  };
  const versionText = (file: typeof entry.conflict) =>
    file?.content.kind === 'text'
      ? file.content.text
      : file?.content.kind === 'absent'
        ? ''
        : t('unknownContent');
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="document-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!canSave} onClick={() => perform(save)}>
          {t(entry.saving ? 'saving' : pending && entry.canRetrySave ? 'retrySave' : 'save')}
        </Button>
        {pending ? (
          <Button
            size="sm"
            variant="outline"
            disabled={entry.saving}
            onClick={() => perform(() => owner.checkSave(documentKey))}
          >
            {t('checkSave')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnlyTarget || entry.saving}
          onClick={() => perform(() => owner.refresh(documentKey))}
        >
          {t('refresh')}
        </Button>
        {entry.formatBlocked ? (
          <Select
            label={t('eol')}
            value={entry.formatBlocked ? null : entry.model?.getEOL() === '\r\n' ? 'crlf' : 'lf'}
            placeholder={t('eol')}
            options={[
              { value: 'lf', label: t('eolLf') },
              { value: 'crlf', label: t('eolCrlf') },
            ]}
            onValueChange={(value) => owner.convertEol(documentKey, value)}
            disabled={
              readOnlyTarget ||
              !entry.file.writable ||
              entry.saving ||
              pending ||
              Boolean(entry.conflict)
            }
            size="sm"
            className="h-8 sm:h-7"
          />
        ) : (
          <span className="text-xs text-muted">
            {entry.model?.getEOL() === '\r\n' ? t('eolCrlf') : t('eolLf')}
          </span>
        )}
        <span role="status" className="text-xs text-muted">
          {t(entry.saving ? 'saving' : pending ? 'pending' : entry.dirty ? 'dirty' : 'saved')}
        </span>
      </div>
      {readOnlyTarget || !entry.file.writable ? (
        <p className="text-xs text-muted">{t('readOnly')}</p>
      ) : null}
      {entry.formatBlocked ? (
        <p role="status" className="text-xs">
          {t('eolHint')}
        </p>
      ) : null}
      {entry.error || actionError ? (
        <p role="alert" className="text-xs text-danger">
          {entry.error || actionError}
        </p>
      ) : null}
      {entry.recoveryError ? (
        <p role="alert" className="text-xs text-danger">
          {t('recoveryUnavailable')}
        </p>
      ) : null}
      {entry.conflict ? (
        <section
          className="flex min-w-0 flex-col gap-2 rounded fill-group p-3"
          aria-label={t('conflict')}
        >
          <p role="alert" className="text-sm font-medium">
            {t('conflict')}
          </p>
          <p className="text-xs text-muted">{t('conflictHint')}</p>
          <DocumentText label={t('base')} text={entry.baseText} />
          <DocumentText label={t('ours')} text={entry.text} />
          <DocumentText label={t('theirs')} text={versionText(entry.conflict)} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={readOnlyTarget || pending || entry.saving}
              onClick={() => {
                if (!owner.resolveConflict(documentKey, 'ours'))
                  setActionError(t('conflictUnavailable'));
              }}
            >
              {t('keepDraft')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnlyTarget || pending || entry.saving}
              onClick={() => {
                if (!owner.resolveConflict(documentKey, 'theirs'))
                  setActionError(t('conflictUnavailable'));
              }}
            >
              {t('useDisk')}
            </Button>
          </div>
        </section>
      ) : null}
      {entry.recoveries.map((recovery) => (
        <section
          key={recovery.id}
          className="flex min-w-0 flex-col gap-2 rounded fill-group p-3"
          aria-label={t('recovery')}
        >
          <p className="text-sm font-medium">{t('recovery')}</p>
          <p className="text-xs text-muted">{t('recoveryHint')}</p>
          <DocumentText label={t('draftContent')} text={recovery.text} />
          {entry.dirty || pending ? (
            <p className="text-xs text-muted">{t('recoveryBlocked')}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={readOnlyTarget || entry.dirty || pending || entry.saving}
              onClick={() => perform(() => owner.restoreRecovery(documentKey, recovery.id))}
            >
              {t('restoreRecovery')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => perform(() => owner.discardRecovery(documentKey, recovery.id))}
            >
              {t('discardRecovery')}
            </Button>
          </div>
        </section>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor={`${rangeId}-from`}>
          {td('fromLine')}{' '}
          <Input
            id={`${rangeId}-from`}
            nativeInput
            size="sm"
            type="number"
            min={1}
            max={lineCount}
            value={range.start}
            onChange={(event) =>
              setRange((value) => ({ ...value, start: event.target.valueAsNumber || 1 }))
            }
            className="w-16"
          />
        </label>
        <label htmlFor={`${rangeId}-to`}>
          {td('toLine')}{' '}
          <Input
            id={`${rangeId}-to`}
            nativeInput
            size="sm"
            type="number"
            min={range.start}
            max={lineCount}
            value={range.end}
            onChange={(event) =>
              setRange((value) => ({ ...value, end: event.target.valueAsNumber || 1 }))
            }
            className="w-16"
          />
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={!validRange || !entry.model || editorFailed}
          onClick={() => setRevealRange({ startLine: range.start, endLine: range.end })}
        >
          {t('goToLines')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canReference}
          onClick={() => onReference({ path: entry.path, ...range })}
        >
          {td('referenceLines')}
        </Button>
      </div>
      {entry.dirty || pending ? <p className="text-xs text-muted">{t('dirtyReference')}</p> : null}
      <section
        aria-label={td('fileContent')}
        className="min-w-0 overflow-hidden rounded fill-group"
      >
        {editorFailed || entry.modelError || entry.formatBlocked ? (
          <>
            {editorFailed || entry.modelError ? (
              <p role="alert" className="p-2 text-xs text-danger">
                {t('editorFailed')}
              </p>
            ) : null}
            <Textarea
              readOnly
              aria-label={t('draftContent')}
              value={entry.text}
              className="font-mono text-xs"
            />
          </>
        ) : entry.model ? (
          <div className="h-[min(45vh,28rem)] min-h-56">
            <Suspense fallback={<p className="p-3 text-xs text-muted">{t('loading')}</p>}>
              <CodeEditorView
                model={entry.model}
                viewId={viewId}
                readOnly={readOnlyTarget || !entry.file.writable}
                ariaLabel={t('editorLabel', { path: entry.path })}
                saveLabel={t('save')}
                onSave={() => perform(save)}
                onSelection={(start, end) => setRange({ start, end })}
                revealRange={revealRange}
                onError={() => setEditorFailed(true)}
                className="h-full min-h-0 min-w-0"
              />
            </Suspense>
          </div>
        ) : (
          <p className="p-3 text-xs text-muted">{t('loading')}</p>
        )}
      </section>
      <p className="text-2xs text-muted">{t('keyboardHint')}</p>
      <p className="text-2xs text-muted">{td('referencePermission')}</p>
    </div>
  );
}

function DocumentText({ label, text }: { label: string; text: string }) {
  return (
    <details className="min-w-0 text-xs">
      <summary className="cursor-pointer py-1 font-medium">{label}</summary>
      <Textarea readOnly aria-label={label} value={text} className="font-mono text-xs" />
    </details>
  );
}
