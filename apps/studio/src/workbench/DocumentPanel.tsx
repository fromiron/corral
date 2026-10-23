import { type TextAttachment, TextRange } from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Input,
  Select,
  Textarea,
} from '@corral/react/ui';
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { type AttachmentCapture, beginAttachmentCapture } from './context/bridge.ts';
import { captureDocumentAttachment } from './context/documents.ts';
import { SourceNavigationContext } from './context/SourceAttachments.tsx';
import { type DebugStore, debugCopyKey } from './debug/store.ts';
import type { LanguageSelection } from './documents/CodeEditorView.tsx';
import type { DocumentStore } from './documents/store.ts';
import { WriterHeld } from './documents/WriterHeld.tsx';
import type { FileReference } from './FilePanel.tsx';
import { LanguageSupport } from './LanguageSupport.tsx';
import type { LanguageStore } from './language/store.ts';

const CodeEditorView = lazy(() =>
  import('./documents/CodeEditorView.tsx').then((module) => ({ default: module.CodeEditorView })),
);
const withoutDebug = () => () => {};

export function DocumentPanel({
  owner,
  documentKey,
  viewId,
  onReference,
  readOnlyTarget = false,
  manageView = true,
  fill = false,
  referencePending = false,
  onAttach,
  revealSelection,
  language,
  debugOwner,
}: {
  owner: DocumentStore;
  language?: LanguageStore;
  debugOwner?: DebugStore;
  documentKey: string;
  viewId: string;
  onReference?: (reference: FileReference) => void;
  readOnlyTarget?: boolean;
  manageView?: boolean;
  fill?: boolean;
  referencePending?: boolean;
  onAttach?: (attachment: TextAttachment, capture: AttachmentCapture) => void | Promise<void>;
  revealSelection?: TextRange;
}) {
  const entry = useStore(owner, (state) => state.documents[documentKey]);
  const debugTarget = entry?.target;
  const debugCopy = useSyncExternalStore(debugOwner?.subscribe ?? withoutDebug, () =>
    entry && debugOwner ? (debugOwner.getState().copies[debugCopyKey(entry.target)] ?? null) : null,
  );
  const navigation = useContext(SourceNavigationContext);
  const t = useTranslations('Documents');
  const td = useTranslations('Desktop');
  const debuggerMessages = useTranslations('Debugger');
  const rangeId = useId();
  const [range, setRange] = useState({ start: 1, end: 1 });
  const [revealRange, setRevealRange] = useState<{ startLine: number; endLine: number }>();
  const [editorFailed, setEditorFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selection, setSelection] = useState<TextRange | null>(null);
  const [languageSelection, setLanguageSelection] = useState<LanguageSelection | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState<{
    attachment: TextAttachment;
    capture: AttachmentCapture;
  } | null>(null);
  const [captureError, setCaptureError] = useState(false);
  const captureButton = useRef<HTMLButtonElement>(null);
  const restoreCaptureFocus = useRef(true);
  const mounted = useRef(true);
  const captureAccess = useRef({ onAttach, blocked: readOnlyTarget || referencePending });
  useEffect(() => {
    captureAccess.current = { onAttach, blocked: readOnlyTarget || referencePending };
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => (manageView ? owner.retainView(documentKey, viewId) : undefined),
    [owner, documentKey, viewId, manageView],
  );
  useEffect(
    () => (debugTarget && debugOwner ? debugOwner.retain(debugTarget) : undefined),
    [debugOwner, debugTarget],
  );
  if (!entry) return null;
  const lineCount = entry.text.split(/\r\n|\r|\n/).length;
  const validRange = range.start >= 1 && range.end >= range.start && range.end <= lineCount;
  const pending = Boolean(entry.pendingSave);
  const debugSession = debugCopy?.state?.session;
  const debugActive =
    debugSession && (debugSession.state === 'running' || debugSession.state === 'paused');
  const debugClean = !entry.dirty && !entry.saving && !pending && !entry.conflict;
  const sourceMismatch =
    debugSession?.breakpoints.some(
      (point) => point.path === entry.path && point.sha256 !== entry.baseHash,
    ) ||
    (debugCopy?.frame?.source.path === entry.path &&
      debugCopy.frame.source.sha256 !== entry.baseHash);
  const paused = debugCopy?.frame;
  const pausedLine =
    debugClean &&
    debugSession?.state === 'paused' &&
    paused?.generation === debugSession.generation &&
    paused.pauseId === debugSession.pauseId &&
    paused.revision === debugSession.revision &&
    paused.source.mapped &&
    paused.source.reason === null &&
    paused.source.path === entry.path &&
    paused.source.sha256 === entry.baseHash
      ? paused.source.line
      : null;
  const canSave =
    !entry.saving &&
    (pending
      ? entry.canRetrySave
      : !readOnlyTarget &&
        entry.file.writable &&
        !entry.conflict &&
        !entry.formatBlocked &&
        entry.dirty);
  const canReference =
    Boolean(onReference) &&
    !referencePending &&
    !readOnlyTarget &&
    validRange &&
    !entry.dirty &&
    !entry.saving &&
    !pending;
  const canAttach =
    Boolean(onAttach) &&
    !referencePending &&
    !readOnlyTarget &&
    !capturing &&
    !captured &&
    Boolean(selection && TextRange.safeParse(selection).success);
  const selectLines = (next: typeof range) => {
    setRange(next);
    const lines = entry.text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    const selected = TextRange.safeParse({
      startLine: next.start,
      startColumn: 1,
      endLine: next.end,
      endColumn: (lines[next.end - 1]?.length ?? 0) + 1,
    });
    setSelection(selected.success ? selected.data : null);
  };
  const attachCaptured = async (candidate: NonNullable<typeof captured>) => {
    setCapturing(true);
    setCaptureError(false);
    try {
      const access = captureAccess.current;
      if (!access.onAttach || access.blocked) throw new Error('Document target is unavailable');
      await access.onAttach(candidate.attachment, candidate.capture);
      if (mounted.current) {
        restoreCaptureFocus.current = false;
        setCaptured(null);
      }
    } catch {
      if (mounted.current) {
        setCaptured(candidate);
        setCaptureError(true);
      }
    } finally {
      if (mounted.current) setCapturing(false);
    }
  };
  const captureSelection = async () => {
    if (!canAttach || !selection) return;
    const capture = beginAttachmentCapture(entry.target);
    const range = { ...selection };
    setCapturing(true);
    setActionError(null);
    setCaptureError(false);
    restoreCaptureFocus.current = true;
    try {
      const attachment = await captureDocumentAttachment(entry, range);
      if (!mounted.current) return;
      const candidate = { attachment, capture };
      if (attachment.provenance?.kind === 'code' && attachment.provenance.snapshot === 'draft')
        setCaptured(candidate);
      else await attachCaptured(candidate);
    } catch {
      if (mounted.current) setActionError(t('captureFailed'));
    } finally {
      if (mounted.current) setCapturing(false);
    }
  };
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
    <div
      className={`flex min-w-0 flex-col gap-2 ${fill ? 'h-full min-h-0' : ''}`}
      data-testid="document-panel"
    >
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
      {language && !readOnlyTarget ? (
        <LanguageSupport owner={owner} documentKey={documentKey} selection={languageSelection} />
      ) : null}
      {debugActive && (!debugClean || sourceMismatch) ? (
        <p className="text-xs text-warning">
          {debuggerMessages(debugClean ? 'sourceMismatch' : 'dirtySource')}
        </p>
      ) : null}
      {readOnlyTarget || !entry.file.writable ? (
        <p className="text-xs text-muted">{t('readOnly')}</p>
      ) : null}
      {entry.formatBlocked ? (
        <p role="status" className="text-xs">
          {t('eolHint')}
        </p>
      ) : null}
      {entry.writerBusy ? (
        <WriterHeld sessionId={entry.target.sessionId} />
      ) : entry.error || actionError ? (
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
                setActionError(
                  owner.resolveConflict(documentKey, 'ours') ? null : t('conflictUnavailable'),
                );
              }}
            >
              {t('keepDraft')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnlyTarget || pending || entry.saving}
              onClick={() => {
                setActionError(
                  owner.resolveConflict(documentKey, 'theirs') ? null : t('conflictUnavailable'),
                );
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
            onChange={(event) => selectLines({ ...range, start: event.target.valueAsNumber || 1 })}
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
            onChange={(event) => selectLines({ ...range, end: event.target.valueAsNumber || 1 })}
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
          onClick={() => onReference?.({ path: entry.path, ...range })}
        >
          {td('referenceLines')}
        </Button>
        {onAttach ? (
          <Button
            ref={captureButton}
            size="sm"
            variant="outline"
            disabled={!canAttach}
            onClick={() => void captureSelection()}
          >
            {t(capturing ? 'capturingSelection' : 'attachSelection')}
          </Button>
        ) : null}
      </div>
      {!onReference ? <p className="text-xs text-muted">{t('otherSessionReference')}</p> : null}
      {referencePending ? (
        <p role="status" className="text-xs text-muted">
          {t('loading')}
        </p>
      ) : null}
      {entry.dirty || pending ? <p className="text-xs text-muted">{t('dirtyReference')}</p> : null}
      <section
        aria-label={td('fileContent')}
        className={`min-w-0 overflow-hidden rounded fill-group ${fill ? 'min-h-56 flex-1' : ''}`}
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
          <div className={fill ? 'h-full min-h-56' : 'h-[min(45vh,28rem)] min-h-56'}>
            <Suspense fallback={<p className="p-3 text-xs text-muted">{t('loading')}</p>}>
              <CodeEditorView
                onLanguageSelection={setLanguageSelection}
                debug={
                  debugActive && debugOwner && !readOnlyTarget
                    ? {
                        breakpoints: debugSession.breakpoints
                          .filter((point) => point.path === entry.path)
                          .map((point) => ({
                            line:
                              debugClean && point.sha256 === entry.baseHash
                                ? point.line
                                : point.requestedLine,
                            verified:
                              debugClean && point.sha256 === entry.baseHash && point.verified,
                          })),
                        pausedLine,
                        canToggle: Boolean(
                          debugCopy?.state?.available &&
                            debugClean &&
                            !referencePending &&
                            !debugCopy.busy &&
                            !debugCopy.pendingCommandId,
                        ),
                        toggleLabel: debuggerMessages('toggleBreakpoint'),
                        onToggle: (line) => {
                          void debugOwner.toggleBreakpoint(
                            documentKey,
                            line,
                            debugSession.generation,
                          );
                        },
                      }
                    : undefined
                }
                onOpenResource={
                  language && navigation
                    ? (resource, range) =>
                        language.openLocation(documentKey, resource, range, navigation.openDocument)
                    : undefined
                }
                model={entry.model}
                viewId={viewId}
                readOnly={readOnlyTarget || !entry.file.writable}
                ariaLabel={t('editorLabel', { path: entry.path })}
                saveLabel={t('save')}
                onSave={() => perform(save)}
                onSelection={(start, end, selected) => {
                  setRange({ start, end });
                  setSelection(selected);
                }}
                revealRange={revealRange}
                revealSelection={revealSelection}
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
      {captured ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !capturing) setCaptured(null);
          }}
        >
          <DialogPopup
            showCloseButton={false}
            bottomStickOnMobile={false}
            finalFocus={() =>
              restoreCaptureFocus.current ? (captureButton.current ?? false) : false
            }
            className="flex max-h-[85dvh] flex-col gap-3 overflow-auto p-6"
          >
            <DialogTitle>
              {t(
                captured.attachment.provenance?.kind === 'code' &&
                  captured.attachment.provenance.snapshot === 'draft'
                  ? 'confirmDraftTitle'
                  : 'selectedSnapshot',
              )}
            </DialogTitle>
            <DialogDescription>
              {captured.attachment.provenance?.kind === 'code' &&
              captured.attachment.provenance.snapshot === 'draft'
                ? t('confirmDraftHint')
                : captured.attachment.name}
            </DialogDescription>
            <Textarea
              readOnly
              aria-label={t('selectedSnapshot')}
              value={captured.attachment.text}
              className="max-h-80 font-mono text-xs"
            />
            {captureError ? (
              <p role="alert" className="text-xs text-danger">
                {t('captureFailed')}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={capturing || !onAttach || readOnlyTarget || referencePending}
                onClick={() => void attachCaptured(captured)}
              >
                {t('attachSnapshot')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={capturing}
                onClick={() => setCaptured(null)}
              >
                {t('cancel')}
              </Button>
            </div>
          </DialogPopup>
        </Dialog>
      ) : null}
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
