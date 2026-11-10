import { type FileEditProposal, type TextAttachment, TextRange } from '@corral/contracts';
import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  fontWeights,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  Popover,
  PopoverPopup,
  Textarea,
  Tooltip,
} from '@corral/react/design-kit';
import { Ellipsis, FileDiff } from '@corral/react/icons';
import {
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { type AttachmentCapture, beginAttachmentCapture } from './context/bridge.ts';
import { captureDocumentAttachment } from './context/documents.ts';
import { SourceNavigationContext } from './context/SourceAttachments.tsx';
import { DocumentHeader, UnsavedMark } from './DocumentHeader.tsx';
import { type DebugStore, debugCopyKey } from './debug/store.ts';
import type { LanguageSelection } from './documents/CodeEditorView.tsx';
import type { DocumentStore } from './documents/store.ts';
import { WriterHeld } from './documents/WriterHeld.tsx';
import { EditProposals, type FileEditClient, usePendingProposals } from './EditProposalReview.tsx';
import type { FileReference } from './FilePanel.tsx';
import { LanguageSupport } from './LanguageSupport.tsx';
import { LineRangePopover } from './LineRangePopover.tsx';
import { type LanguageStore, languageCopyKey } from './language/store.ts';

const CodeEditorView = lazy(() =>
  import('./documents/CodeEditorView.tsx').then((module) => ({ default: module.CodeEditorView })),
);
const withoutDebug = () => () => {};
// Monaco's own chord for switching what Tab does.
const tabFocusChord = () =>
  /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌃⇧M' : 'Ctrl+M';

/**
 * One document: a one-row head (path, target, branch, save state, Save and a more menu), the
 * facts that block it right now, then the editor filling what is left.
 */
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
  edits,
  headExtra,
  children,
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
  /** Edit proposals of this copy: their review and the count still waiting. */
  edits?: FileEditClient;
  /** Controls at the end of the head, such as a close button. */
  headExtra?: ReactNode;
  /** Shown under the head, above the editor, such as a preview or a notice about the tab. */
  children?: ReactNode;
}) {
  const entry = useStore(owner, (state) => state.documents[documentKey]);
  const debugTarget = entry?.target;
  const debugCopy = useSyncExternalStore(debugOwner?.subscribe ?? withoutDebug, () =>
    entry && debugOwner ? (debugOwner.getState().copies[debugCopyKey(entry.target)] ?? null) : null,
  );
  const languageCopy = useSyncExternalStore(language?.subscribe ?? withoutDebug, () =>
    entry && language ? (language.getState().copies[languageCopyKey(entry.target)] ?? null) : null,
  );
  const navigation = useContext(SourceNavigationContext);
  const t = useTranslations('Documents');
  const td = useTranslations('Desktop');
  const tl = useTranslations('Language');
  const tp = useTranslations('EditProposals');
  const debuggerMessages = useTranslations('Debugger');
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
  const [lines, setLines] = useState<'go' | 'reference' | null>(null);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [review, setReview] = useState<FileEditProposal | null>(null);
  const [historyRequest, setHistoryRequest] = useState(0);
  const [proposalRevision, setProposalRevision] = useState(0);
  const [tabFocusRequest, setTabFocusRequest] = useState(0);
  const pendingProposals = usePendingProposals(edits, entry?.target, proposalRevision);
  // The more menu's trigger: popovers opened from the menu sit against it and return focus to it.
  const more = useRef<HTMLButtonElement>(null);
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
  const eolDisabled =
    readOnlyTarget || !entry.file.writable || entry.saving || pending || Boolean(entry.conflict);
  const selectLines = (next: typeof range) => {
    setRange(next);
    const lines = entry.text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
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
  // A popover opened from a menu row waits for the menu to hand focus back first.
  const afterMenu = (open: () => void) => requestAnimationFrame(open);
  const showHistory = () => setHistoryRequest((value) => value + 1);
  const versionText = (file: typeof entry.conflict) =>
    file?.content.kind === 'text'
      ? file.content.text
      : file?.content.kind === 'absent'
        ? ''
        : t('unknownContent');
  const saveState = entry.saving ? 'saving' : pending ? 'pending' : entry.dirty ? 'dirty' : 'saved';
  const languageSession = languageCopy?.state?.session;
  const referenceNote = !onReference
    ? t('otherSessionReference')
    : entry.dirty || pending
      ? t('dirtyReference')
      : referencePending
        ? t('loading')
        : td('referencePermission');
  const status = (
    <>
      <span role="status" className="inline-flex min-w-0 shrink items-center">
        {saveState === 'dirty' ? (
          <UnsavedMark label={t('dirty')} />
        ) : (
          <span
            className={
              saveState === 'pending' ? 'truncate text-warning' : 'truncate @max-xl/head:sr-only'
            }
          >
            {t(saveState)}
          </span>
        )}
      </span>
      {entry.formatBlocked ? null : (
        <span className="shrink-0 @max-2xl/head:hidden">
          {entry.model?.getEOL() === '\r\n' ? t('eolCrlf') : t('eolLf')}
        </span>
      )}
    </>
  );
  const actions = (
    <>
      {edits && pendingProposals ? (
        <Tooltip content={tp('pendingCount', { count: pendingProposals })}>
          <Button
            size="compact"
            variant="secondary"
            aria-label={tp('pendingCount', { count: pendingProposals })}
            onClick={showHistory}
            className="tabular-nums"
          >
            <FileDiff aria-hidden />
            {pendingProposals}
          </Button>
        </Tooltip>
      ) : null}
      {pending ? (
        <Button
          size="compact"
          variant="tertiary"
          disabled={entry.saving}
          onClick={() => perform(() => owner.checkSave(documentKey))}
        >
          {t('checkSave')}
        </Button>
      ) : null}
      <Button
        size="compact"
        // While another writer holds the copy, the banner's own actions lead and Save steps back.
        variant={entry.writerBusy ? 'secondary' : canSave ? 'primary' : 'ghost'}
        disabled={!canSave}
        onClick={() => perform(save)}
      >
        {t(entry.saving ? 'saving' : pending && entry.canRetrySave ? 'retrySave' : 'save')}
      </Button>
      <Menu>
        <Tooltip content={t('moreActions', { path: entry.path })}>
          <MenuTrigger
            ref={more}
            render={
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={t('moreActions', { path: entry.path })}
              />
            }
          >
            <Ellipsis />
          </MenuTrigger>
        </Tooltip>
        <MenuPopup align="end" className="min-w-56">
          <MenuItem
            disabled={readOnlyTarget || entry.saving}
            onClick={() => perform(() => owner.refresh(documentKey))}
          >
            {t('refresh')}
          </MenuItem>
          {edits ? (
            <MenuItem
              label={
                pendingProposals
                  ? `${tp('history')}, ${tp('pendingCount', { count: pendingProposals })}`
                  : tp('history')
              }
              onClick={showHistory}
            >
              <MenuRow trailing={pendingProposals || null}>{tp('history')}</MenuRow>
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem
            disabled={!entry.model || editorFailed}
            onClick={() => afterMenu(() => setLines('go'))}
          >
            {t('goToLinesMenu')}
          </MenuItem>
          <MenuItem onClick={() => afterMenu(() => setLines('reference'))}>
            {t('referenceLinesMenu')}
          </MenuItem>
          {onAttach ? (
            <MenuItem disabled={!canAttach} onClick={() => void captureSelection()}>
              {t(capturing ? 'capturingSelection' : 'attachSelection')}
            </MenuItem>
          ) : null}
          {entry.formatBlocked ? (
            <MenuSub>
              <MenuSubTrigger>{t('eol')}</MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem
                  disabled={eolDisabled}
                  onClick={() => owner.convertEol(documentKey, 'lf')}
                >
                  {t('eolLf')}
                </MenuItem>
                <MenuItem
                  disabled={eolDisabled}
                  onClick={() => owner.convertEol(documentKey, 'crlf')}
                >
                  {t('eolCrlf')}
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
          ) : null}
          {language && !readOnlyTarget ? (
            <>
              <MenuSeparator />
              <MenuItem
                label={
                  languageSession
                    ? `${tl('label')}, ${tl(languageSession.state)}`
                    : `${tl('label')}…`
                }
                onClick={() => afterMenu(() => setLanguageOpen(true))}
              >
                <MenuRow trailing={languageSession ? tl(languageSession.state) : null}>
                  {`${tl('label')}…`}
                </MenuRow>
              </MenuItem>
            </>
          ) : null}
          {entry.model && !editorFailed ? (
            <>
              <MenuSeparator />
              <MenuItem
                label={`${t('tabFocus')}, ${tabFocusChord()}`}
                onClick={() => setTabFocusRequest((value) => value + 1)}
              >
                <MenuRow trailing={<kbd className="font-sans text-micro">{tabFocusChord()}</kbd>}>
                  {t('tabFocus')}
                </MenuRow>
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {headExtra}
    </>
  );
  return (
    <div
      className={`flex min-w-0 flex-col ${fill ? 'min-h-0 flex-1' : ''}`}
      data-testid="document-panel"
    >
      <DocumentHeader
        path={entry.path}
        target={{ kind: 'copy', target: entry.target }}
        status={status}
        actions={actions}
      />
      <div className={`flex min-w-0 flex-col ${fill ? 'min-h-0 flex-1 overflow-auto' : ''}`}>
        {/* Only what blocks this document right now; nothing stands here otherwise. */}
        <div className="flex min-w-0 flex-col gap-2 px-3 py-2 empty:hidden">
          {debugActive && (!debugClean || sourceMismatch) ? (
            <p className="text-caption text-warning">
              {debuggerMessages(debugClean ? 'sourceMismatch' : 'dirtySource')}
            </p>
          ) : null}
          {readOnlyTarget || !entry.file.writable ? (
            <p className="text-caption text-muted-foreground">{t('readOnly')}</p>
          ) : null}
          {entry.formatBlocked ? (
            <Banner status="warning" size="compact" role="status">
              <BannerTitle>{t('eolHint')}</BannerTitle>
              <BannerActions>
                <Button
                  size="compact"
                  variant="secondary"
                  disabled={eolDisabled}
                  onClick={() => owner.convertEol(documentKey, 'lf')}
                >
                  {t('eolLf')}
                </Button>
                <Button
                  size="compact"
                  variant="secondary"
                  disabled={eolDisabled}
                  onClick={() => owner.convertEol(documentKey, 'crlf')}
                >
                  {t('eolCrlf')}
                </Button>
              </BannerActions>
            </Banner>
          ) : null}
          {entry.writerBusy ? (
            <WriterHeld key={documentKey} target={entry.target} />
          ) : entry.error || actionError ? (
            <p role="alert" className="text-caption text-danger">
              {entry.error || actionError}
            </p>
          ) : null}
          {entry.recoveryError ? (
            <p role="alert" className="text-caption text-danger">
              {t('recoveryUnavailable')}
            </p>
          ) : null}
          {referencePending ? (
            <p role="status" className="text-caption text-muted-foreground">
              {t('loading')}
            </p>
          ) : null}
          {entry.conflict ? (
            <section
              className="flex min-w-0 flex-col gap-2 rounded fill-group p-3"
              aria-label={t('conflict')}
            >
              <p
                role="alert"
                className="text-body"
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {t('conflict')}
              </p>
              <p className="text-caption text-muted-foreground">{t('conflictHint')}</p>
              <DocumentText label={t('base')} text={entry.baseText} />
              <DocumentText label={t('ours')} text={entry.text} />
              <DocumentText label={t('theirs')} text={versionText(entry.conflict)} />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="compact"
                  variant="tertiary"
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
                  size="compact"
                  variant="ghost"
                  disabled={readOnlyTarget || pending || entry.saving}
                  onClick={() => {
                    setActionError(
                      owner.resolveConflict(documentKey, 'theirs')
                        ? null
                        : t('conflictUnavailable'),
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
              <p className="text-body" style={{ fontVariationSettings: fontWeights.semibold }}>
                {t('recovery')}
              </p>
              <p className="text-caption text-muted-foreground">{t('recoveryHint')}</p>
              <DocumentText label={t('draftContent')} text={recovery.text} />
              {entry.dirty || pending ? (
                <p className="text-caption text-muted-foreground">{t('recoveryBlocked')}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={readOnlyTarget || entry.dirty || pending || entry.saving}
                  onClick={() => perform(() => owner.restoreRecovery(documentKey, recovery.id))}
                >
                  {t('restoreRecovery')}
                </Button>
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() => perform(() => owner.discardRecovery(documentKey, recovery.id))}
                >
                  {t('discardRecovery')}
                </Button>
              </div>
            </section>
          ))}
          {children}
        </div>
        <section
          aria-label={td('fileContent')}
          className={`flex min-w-0 flex-col overflow-hidden ${fill ? 'min-h-48 flex-1' : ''}`}
        >
          {editorFailed || entry.modelError || entry.formatBlocked ? (
            <div className="flex flex-col gap-2 p-3">
              {editorFailed || entry.modelError ? (
                <p role="alert" className="text-caption text-danger">
                  {t('editorFailed')}
                </p>
              ) : null}
              <Textarea
                readOnly
                aria-label={t('draftContent')}
                value={entry.text}
                className="font-mono text-caption"
              />
            </div>
          ) : entry.model ? (
            <div className={fill ? 'min-h-0 flex-1' : 'h-[min(45vh,28rem)] min-h-56'}>
              <Suspense
                fallback={<p className="p-3 text-caption text-muted-foreground">{t('loading')}</p>}
              >
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
                          language.openLocation(
                            documentKey,
                            resource,
                            range,
                            navigation.openDocument,
                          )
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
                  tabFocusRequest={tabFocusRequest}
                  onError={() => setEditorFailed(true)}
                  className="h-full min-h-0 min-w-0"
                />
              </Suspense>
            </div>
          ) : (
            <p className="p-3 text-caption text-muted-foreground">{t('loading')}</p>
          )}
        </section>
      </div>
      <LineRangePopover
        open={lines !== null}
        onOpenChange={(open) => {
          if (!open) setLines(null);
        }}
        anchor={more}
        action={lines === 'reference' ? td('referenceLines') : t('goToLines')}
        range={range}
        lineCount={lineCount}
        onRange={selectLines}
        disabled={
          lines === 'reference' ? !canReference : !validRange || !entry.model || editorFailed
        }
        note={lines === 'reference' ? referenceNote : undefined}
        onSubmit={(value) => {
          if (lines === 'reference') onReference?.({ path: entry.path, ...value });
          else setRevealRange({ startLine: value.start, endLine: value.end });
          setLines(null);
        }}
      />
      {language && !readOnlyTarget ? (
        // Kept mounted so a language preview or rename in progress survives closing it.
        <Popover open={languageOpen} onOpenChange={setLanguageOpen}>
          <PopoverPopup
            anchor={more}
            align="end"
            width="lg"
            keepMounted
            finalFocus={more}
            aria-label={tl('label')}
          >
            <LanguageSupport
              owner={owner}
              documentKey={documentKey}
              selection={languageSelection}
              onReview={(proposal) => {
                setLanguageOpen(false);
                setReview(proposal);
              }}
            />
          </PopoverPopup>
        </Popover>
      ) : null}
      {edits ? (
        <EditProposals
          api={edits}
          owner={owner}
          target={entry.target}
          proposal={review}
          historyRequest={historyRequest}
          trigger={false}
          onConsumed={() => {
            setReview(null);
            setProposalRevision((value) => value + 1);
          }}
        />
      ) : null}
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
            finalFocus={() => (restoreCaptureFocus.current ? (more.current ?? false) : false)}
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
              className="max-h-80 font-mono text-caption"
            />
            {captureError ? (
              <p role="alert" className="text-caption text-danger">
                {t('captureFailed')}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="compact"
                disabled={capturing || !onAttach || readOnlyTarget || referencePending}
                onClick={() => void attachCaptured(captured)}
              >
                {t('attachSnapshot')}
              </Button>
              <Button
                size="compact"
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

/** A menu row's label with a quiet value at its end, such as a count or a shortcut. */
function MenuRow({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <span className="flex w-full min-w-0 items-center gap-4">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing !== null && trailing !== undefined ? (
        <span aria-hidden className="shrink-0 text-micro text-muted-foreground tabular-nums">
          {trailing}
        </span>
      ) : null}
    </span>
  );
}

function DocumentText({ label, text }: { label: string; text: string }) {
  return (
    <details className="min-w-0 text-caption">
      <summary
        className="cursor-pointer py-1"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {label}
      </summary>
      <Textarea readOnly aria-label={label} value={text} className="font-mono text-caption" />
    </details>
  );
}
