import type { FileSideView } from '@corral/client';
import type { TextAttachment, TextRange, WorkspaceTarget } from '@corral/contracts';
import { FileText, RefreshCw, X } from '@corral/react/icons';
import { Button, Input, Select, Textarea } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { useRemembered } from '../pages/Workbench.tsx';
import { useServices } from '../services.tsx';
import { ContentSearch } from './ContentSearch.tsx';
import type { AttachmentCapture } from './context/bridge.ts';
import { DocumentPanel } from './DocumentPanel.tsx';
import { DocumentCloseDialog } from './documents/DocumentCloseDialog.tsx';
import type { RecoveryDraft } from './documents/recovery.ts';
import { type CloseChoice, type DocumentBuffer, documentStore } from './documents/store.ts';
import { languageStore } from './language/store.ts';
import { useSettingsNavigation } from './navigation.ts';
import { useWorkspaceFiles } from './useWorkspaceFiles.ts';

const SourceCode = lazy(() =>
  import('./PierreCode.tsx').then((module) => ({ default: module.SourceCode })),
);
const noDocuments = { documents: {} as Record<string, DocumentBuffer> };
const noSubscription = () => () => {};
const emptyDocuments = () => noDocuments;
const fileViewId = (sessionId: string, path: string) => JSON.stringify(['files', sessionId, path]);

export interface FileReference {
  path: string;
  start: number;
  end: number;
}
export interface OpenDocumentRequest {
  documentKey: string;
  target: WorkspaceTarget;
  path: string;
}
export const referenceText = ({ path, start, end }: FileReference) =>
  `@${path.includes(' ') ? JSON.stringify(path) : path}:L${start}${end === start ? '' : `-L${end}`}`;

/**
 * The file browser. Session-copy files open in the dock's document tabs, the one tab
 * strip; an original-folder file shows a single read-only preview here (#87).
 */
export function FilePanel({
  projectId,
  sessionId,
  onReference,
  onAttach,
  onOpenDocument,
}: {
  projectId: string;
  sessionId: string;
  onReference: (reference: FileReference) => void;
  onAttach?: (attachment: TextAttachment, capture: AttachmentCapture) => void | Promise<void>;
  onOpenDocument?: (document: OpenDocumentRequest, range?: TextRange) => boolean;
}) {
  const t = useTranslations('Desktop');
  const tf = useTranslations('Files');
  const te = useTranslations('Documents');
  const td = useTranslations('Docking');
  const ts = useTranslations('ContentSearch');
  const navigation = useSettingsNavigation();
  const services = useServices();
  const { workspaces, mode, workspaceId } = services;
  const owner = workspaces && mode === 'server' ? documentStore(workspaces) : null;
  const { documents } = useSyncExternalStore(
    owner?.subscribe ?? noSubscription,
    owner?.getState ?? emptyDocuments,
    emptyDocuments,
  );
  const [savedSource, setSource] = useRemembered<'project' | 'session' | null>(
    `corral:file-source:v1:${sessionId}`,
    null,
  );
  const source = savedSource === 'project' || savedSource === 'session' ? savedSource : undefined;
  const { scope, list, hasCopy, copy, loading, error, refresh } = useWorkspaceFiles(
    projectId,
    sessionId,
    source,
  );
  const [saved, setPreview] = useRemembered<string | null>(
    `corral:file-preview:v1:${sessionId}:${scope?.kind ?? 'project'}`,
    null,
  );
  const active = typeof saved === 'string' ? saved : null;
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'names' | 'contents'>('names');
  const [content, setContent] = useState<FileSideView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [documentKey, setDocumentKey] = useState<string | null>(null);
  const [retainedKey, setRetainedKey] = useState<string | null>(null);
  const [sessionRecoveries, setSessionRecoveries] = useState<RecoveryDraft[]>([]);
  const [recoveryReadError, setRecoveryReadError] = useState(false);
  const documentKeys = useRef(new Map<string, string>());
  const openEpoch = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Completed reads must not open a dock in another host or session.
  useEffect(
    () => () => {
      openEpoch.current++;
    },
    [owner, projectId, sessionId],
  );
  const [tabMessage, setTabMessage] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ key: string; path: string } | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState(false);
  const [range, setRange] = useState({ start: 1, end: 1 });
  const refreshRecoveries = useCallback(async () => {
    if (!owner || !workspaceId) return;
    const candidates = await owner.sessionRecoveries({ hostId: workspaceId, projectId, sessionId });
    setSessionRecoveries(candidates);
    setRecoveryReadError(false);
  }, [owner, workspaceId, projectId, sessionId]);
  useEffect(() => {
    void list;
    void refreshRecoveries().catch(() => setRecoveryReadError(true));
  }, [refreshRecoveries, list]);
  const files = list.files.filter((f) => f.path.toLowerCase().includes(query.toLowerCase()));
  const scroll = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({
    count: files.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 30,
    overscan: 6,
  });
  const removeTab = (path: string) => {
    if (active === path) setPreview(null);
    setTabMessage(null);
  };
  const scopeKind = scope?.kind;
  const scopeId = scope?.id;
  const currentCopy = (entry: DocumentBuffer | undefined) =>
    Boolean(
      entry &&
        copy &&
        !copy.missing &&
        !copy.removedAt &&
        entry.target.bindingId === copy.bindingId &&
        entry.target.copyGeneration === copy.copyGeneration,
    );
  const open = async (path: string, sessionFile = false) => {
    setReadError(null);
    if (onOpenDocument && owner && (scopeKind === 'session' || sessionFile)) {
      const epoch = openEpoch.current;
      try {
        const key = await owner.open(sessionId, path);
        if (openEpoch.current !== epoch) return;
        const entry = owner.getState().documents[key];
        // Whatever the file holds, a session-copy file has one home: its document tab.
        if (entry) {
          if (onOpenDocument({ documentKey: key, target: entry.target, path: entry.path }))
            removeTab(path);
          else setTabMessage(td('tabLimit'));
          return;
        }
      } catch (failure) {
        if (openEpoch.current === epoch)
          setReadError(failure instanceof Error ? failure.message : String(failure));
        return;
      }
    }
    setTabMessage(null);
    setPreview(path);
  };
  const retained = Object.values(documents).filter(
    (entry) =>
      entry.target.sessionId === sessionId &&
      (entry.dirty || entry.pendingSave) &&
      (!scope || !currentCopy(entry)),
  );
  const buffered = (path: string) => {
    const key = documentKeys.current.get(path);
    return (
      (key && currentCopy(documents[key]) ? documents[key] : undefined) ??
      Object.values(documents)
        .filter(
          (entry) =>
            entry.target.sessionId === sessionId && entry.path === path && currentCopy(entry),
        )
        .at(-1)
    );
  };
  const close = async (path: string, choice?: CloseChoice, requestedKey?: string) => {
    const entry = requestedKey
      ? documents[requestedKey]
      : scopeKind === 'session'
        ? buffered(path)
        : undefined;
    if (!entry || !owner) return removeTab(path);
    setCloseBusy(true);
    setCloseError(false);
    try {
      const result = await owner.closeView(entry.key, fileViewId(sessionId, path), choice);
      if (result === 'closed') {
        if (currentCopy(entry)) removeTab(path);
        else setRetainedKey(null);
        setClosing(null);
        void refreshRecoveries().catch(() => setRecoveryReadError(true));
      } else if (result === 'cancelled') setClosing(null);
      else {
        setClosing({ key: entry.key, path });
        setCloseError(result === 'failed');
      }
    } catch {
      setClosing({ key: entry.key, path });
      setCloseError(true);
    } finally {
      setCloseBusy(false);
    }
  };
  useEffect(() => {
    // A refreshed listing also invalidates the open file's content.
    void list;
    const previous =
      active && scopeKind === 'session' && owner
        ? Object.values(owner.getState().documents).find(
            (entry) =>
              entry.target.sessionId === sessionId &&
              entry.path === active &&
              entry.target.bindingId === copy?.bindingId &&
              entry.target.copyGeneration === copy?.copyGeneration,
          )
        : undefined;
    setContent(previous?.file.content ?? null);
    setDocumentKey(previous?.key ?? null);
    setReadError(null);
    setRange({ start: 1, end: 1 });
    if (!active || !scopeKind || !scopeId || !workspaces) return;
    let live = true;
    if (scopeKind === 'session' && owner) {
      void owner.open(sessionId, active).then(
        (key) => {
          if (!live) return;
          documentKeys.current.set(active, key);
          setDocumentKey(key);
          setContent(owner.getState().documents[key]?.file.content ?? null);
        },
        (failure: unknown) => {
          if (live) setReadError(failure instanceof Error ? failure.message : String(failure));
        },
      );
    } else
      void workspaces.readFile({ kind: scopeKind, id: scopeId }, active).then(
        (file) => {
          if (live) setContent(file.content);
        },
        (failure: unknown) => {
          if (live) setReadError(failure instanceof Error ? failure.message : String(failure));
        },
      );
    return () => {
      live = false;
    };
  }, [
    workspaces,
    owner,
    sessionId,
    active,
    scopeKind,
    scopeId,
    list,
    copy?.bindingId,
    copy?.copyGeneration,
  ]);
  const closingEntry = closing ? documents[closing.key] : undefined;
  const closeDialog = (
    <DocumentCloseDialog
      path={closing?.path ?? null}
      busy={closeBusy}
      failed={closeError || Boolean(closingEntry?.pendingSave)}
      saveDisabled={
        !currentCopy(closingEntry) ||
        Boolean(closingEntry?.pendingSave && !closingEntry?.canRetrySave)
      }
      discardDisabled={Boolean(closingEntry?.pendingSave)}
      finalFocus={() =>
        panel.current?.querySelector<HTMLElement>('[data-testid="file-preview-pane"] button') ??
        panel.current?.querySelector<HTMLElement>('button') ??
        false
      }
      onChoose={(choice) => closing && void close(closing.path, choice, closing.key)}
      onDismiss={() => setClosing(null)}
    />
  );
  const candidates = sessionRecoveries.filter(
    (candidate) =>
      !retained.some(
        (entry) => entry.key === candidate.documentKey && entry.text === candidate.text,
      ),
  );
  const recoveryCandidates =
    owner && candidates.length ? (
      <section
        className="flex min-w-0 flex-col gap-2 rounded fill-group p-3"
        aria-label={te('recovery')}
      >
        <p className="text-sm font-medium">{te('recovery')}</p>
        {candidates.map((candidate) => {
          const sameCopy = Boolean(
            copy &&
              !copy.missing &&
              !copy.removedAt &&
              candidate.target.bindingId === copy.bindingId &&
              candidate.target.copyGeneration === copy.copyGeneration,
          );
          return (
            <details key={candidate.id} className="min-w-0 text-xs">
              <summary className="cursor-pointer break-all py-2 font-medium">
                {candidate.path}
              </summary>
              <p className="mb-2 text-muted">
                {te(sameCopy ? 'recoveryHint' : 'previousCopyHint')}
              </p>
              <Textarea
                readOnly
                aria-label={te('draftContent')}
                value={candidate.text}
                className="font-mono text-xs"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {sameCopy ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSource('session');
                      void open(candidate.path, true);
                    }}
                  >
                    {te('openRecoveryFile')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void owner
                      .discardRecoveryCandidate(candidate)
                      .then(refreshRecoveries)
                      .catch(() => setRecoveryReadError(true));
                  }}
                >
                  {te('discardRecovery')}
                </Button>
              </div>
            </details>
          );
        })}
      </section>
    ) : null;
  const retainedDrafts =
    owner && retained.length ? (
      <section
        className="flex min-w-0 flex-col gap-2 rounded fill-group p-3"
        aria-label={te(scope ? 'previousCopy' : 'preservedDrafts')}
      >
        <p className="text-sm font-medium">{te(scope ? 'previousCopy' : 'preservedDrafts')}</p>
        <p className="text-xs text-muted">
          {te(scope ? 'previousCopyHint' : 'unavailableDraftHint')}
        </p>
        {retained.map((entry) => (
          <div key={entry.key} className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm-multiline"
              className="min-w-0 flex-1 justify-start break-all text-left"
              onClick={() => setRetainedKey(entry.key)}
            >
              {entry.path}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('closeFile', { path: entry.path })}
              onClick={() => void close(entry.path, undefined, entry.key)}
            >
              <X />
            </Button>
          </div>
        ))}
        {retained.some((entry) => entry.key === retainedKey) && retainedKey ? (
          <DocumentPanel
            key={retainedKey}
            owner={owner}
            documentKey={retainedKey}
            viewId={fileViewId(sessionId, documents[retainedKey]?.path ?? '')}
            onReference={onReference}
            onAttach={onAttach}
            readOnlyTarget
          />
        ) : null}
      </section>
    ) : null;
  if (!scope && !loading)
    return (
      <div ref={panel} className="space-y-2 p-3 text-xs text-muted">
        {retainedDrafts}
        {recoveryCandidates}
        {recoveryReadError ? <p role="alert">{te('recoveryReadFailed')}</p> : null}
        {closeDialog}
        {error ? <p role="alert">{error}</p> : <p>{t('linkToBrowse')}</p>}
        <Link {...navigation.link('workspace', projectId)} className="text-accent underline">
          {t('workspace')}
        </Link>
      </div>
    );
  const currentDocument = documentKey ? documents[documentKey] : undefined;
  const displayContent =
    scopeKind === 'session' && owner ? (currentDocument?.file.content ?? content) : content;
  const lineCount = displayContent?.kind === 'text' ? displayContent.text.split('\n').length : 1;
  // Only a session copy without the dock edits in place; the dock owns those documents.
  const inlineEditor = Boolean(
    scopeKind === 'session' &&
      owner &&
      documentKey &&
      documents[documentKey] &&
      (documents[documentKey].file.content.kind === 'text' ||
        documents[documentKey].dirty ||
        documents[documentKey].pendingSave ||
        documents[documentKey].recoveries.length),
  );
  const searchModeControl = (
    <Select
      label={ts('mode')}
      size="sm"
      value={searchMode}
      onValueChange={setSearchMode}
      options={[
        { value: 'names' as const, label: ts('names') },
        { value: 'contents' as const, label: ts('contents') },
      ]}
    />
  );
  const searchTarget: WorkspaceTarget | null =
    scopeKind === 'session' && copy && workspaceId && !copy.missing && !copy.removedAt
      ? {
          hostId: workspaceId,
          projectId,
          sessionId,
          bindingId: copy.bindingId,
          copyGeneration: copy.copyGeneration,
        }
      : null;
  return (
    <div ref={panel} className="flex min-h-0 flex-col gap-2" data-testid="file-panel">
      {retainedDrafts}
      {recoveryCandidates}
      {recoveryReadError ? (
        <p role="alert" className="text-xs text-danger">
          {te('recoveryReadFailed')}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Select
          label={t('fileSource')}
          size="xs"
          variant="ghost"
          className="min-w-0 flex-1 justify-start"
          value={scopeKind ?? 'project'}
          onValueChange={setSource}
          options={[
            { value: 'project' as const, label: t('sourceFolder') },
            ...(hasCopy ? [{ value: 'session' as const, label: t('sessionCopy') }] : []),
          ]}
        />
        <Button size="icon-xs" variant="ghost" aria-label={t('refreshFiles')} onClick={refresh}>
          <RefreshCw />
        </Button>
      </div>
      {searchMode === 'contents' ? (
        searchTarget && workspaces && owner && onOpenDocument ? (
          <ContentSearch
            key={JSON.stringify(searchTarget)}
            api={workspaces}
            edits={workspaces}
            owner={owner}
            target={searchTarget}
            onOpenDocument={onOpenDocument}
            modeControl={searchModeControl}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex min-w-0 items-center gap-2">
              {searchModeControl}
              <Input
                size="sm"
                disabled
                placeholder={ts('placeholder')}
                aria-label={ts('placeholder')}
                className="min-w-0 flex-1"
              />
            </div>
            <p className="text-xs text-muted">{ts('needsCopy')}</p>
          </div>
        )
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          {searchModeControl}
          <Input
            size="sm"
            aria-label={t('filterFiles')}
            placeholder={t('filterFiles')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1"
          />
        </div>
      )}
      {searchMode === 'names' ? (
        <>
          <div ref={scroll} className="h-44 overflow-auto">
            <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
              {rows.getVirtualItems().map((row) => {
                const file = files[row.index];
                if (!file) return null;
                return (
                  <button
                    key={file.path}
                    type="button"
                    aria-label={t('openFile', { path: file.path })}
                    title={file.path}
                    onClick={() => open(file.path)}
                    style={{
                      position: 'absolute',
                      top: row.start,
                      left: 0,
                      width: '100%',
                      height: row.size,
                    }}
                    className={`flex items-center gap-2 rounded px-2 text-left text-xs hover:bg-raised ${active === file.path ? 'bg-sidebar-selected' : ''}`}
                  >
                    <FileText size={14} className="shrink-0 text-muted" />
                    <span className="truncate">{file.path}</span>
                  </button>
                );
              })}
            </div>
            {!loading && !files.length ? (
              <p className="p-2 text-xs text-muted">{t('noFiles')}</p>
            ) : null}
          </div>
          {list.truncated ? (
            <p role="note" className="text-xs text-muted">
              {t('filesTruncated')}
            </p>
          ) : null}
        </>
      ) : null}
      {tabMessage ? (
        <p role="status" className="text-xs text-muted">
          {tabMessage}
        </p>
      ) : null}
      {active ? (
        <section
          data-testid="file-preview-pane"
          aria-label={active}
          className="flex min-w-0 flex-col gap-2 border-t border-line pt-2"
        >
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <p className="min-w-0 flex-1 truncate font-medium" title={active}>
              {active}
            </p>
            {inlineEditor ? null : (
              <span className="text-2xs text-muted">{tf('readOnlyPreview')}</span>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('closeFile', { path: active })}
              onClick={() => void close(active)}
            >
              <X />
            </Button>
          </div>
          {readError ? (
            <p role="alert" className="text-xs text-danger">
              {readError}
            </p>
          ) : null}
          {!displayContent && !readError ? (
            <p className="text-xs text-muted">{t('loadingFile')}</p>
          ) : null}
          {inlineEditor && owner && documentKey && documents[documentKey] ? (
            <DocumentPanel
              key={documentKey}
              owner={owner}
              documentKey={documentKey}
              language={
                services.mode === 'server' && services.workspaces?.languageState
                  ? languageStore(services.workspaces, owner)
                  : undefined
              }
              viewId={fileViewId(sessionId, documents[documentKey].path)}
              onReference={onReference}
              onAttach={onAttach}
              readOnlyTarget={!currentCopy(documents[documentKey])}
            />
          ) : displayContent?.kind === 'text' ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label>
                  {t('fromLine')}{' '}
                  <input
                    type="number"
                    min={1}
                    max={lineCount}
                    value={range.start}
                    onChange={(e) =>
                      setRange((r) => ({ ...r, start: e.target.valueAsNumber || 1 }))
                    }
                    className="w-14 rounded fill-control px-1"
                  />
                </label>
                <label>
                  {t('toLine')}{' '}
                  <input
                    type="number"
                    min={range.start}
                    max={lineCount}
                    value={range.end}
                    onChange={(e) => setRange((r) => ({ ...r, end: e.target.valueAsNumber || 1 }))}
                    className="w-14 rounded fill-control px-1"
                  />
                </label>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={range.start < 1 || range.end < range.start || range.end > lineCount}
                  onClick={() => onReference({ path: active, ...range })}
                >
                  {t('referenceLines')}
                </Button>
              </div>
              <section
                aria-label={t('fileContent')}
                className="max-h-[45vh] overflow-auto rounded fill-group"
              >
                <Suspense fallback={<p className="p-3 text-xs text-muted">{t('loadingFile')}</p>}>
                  <SourceCode path={active} text={displayContent.text} onSelect={setRange} />
                </Suspense>
              </section>
              <p className="text-2xs text-muted">{t('referencePermission')}</p>
            </>
          ) : displayContent ? (
            <p className="text-xs text-muted">
              {displayContent.kind === 'too_large'
                ? tf('tooLarge')
                : displayContent.kind === 'binary'
                  ? tf('binary')
                  : t('fileUnavailable')}
            </p>
          ) : null}
        </section>
      ) : null}
      {closeDialog}
    </div>
  );
}
