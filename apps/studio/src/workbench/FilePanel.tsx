import type { FileSideView } from '@corral/client';
import { FileText, RefreshCw, X } from '@corral/react/icons';
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
import { DocumentPanel } from './DocumentPanel.tsx';
import type { RecoveryDraft } from './documents/recovery.ts';
import { type CloseChoice, type DocumentBuffer, documentStore } from './documents/store.ts';
import { canPreviewFile, FilePreview } from './FilePreview.tsx';
import { useSettingsNavigation } from './navigation.ts';
import { PreviewLeases } from './PreviewLeases.tsx';
import { ServicePreview } from './ServicePreview.tsx';
import { TerminalPanel } from './TerminalPanel.tsx';
import { useWorkspaceFiles } from './useWorkspaceFiles.ts';
import { WorktreeCommandPanel } from './WorktreeCommandPanel.tsx';

const SourceCode = lazy(() =>
  import('./PierreCode.tsx').then((module) => ({ default: module.SourceCode })),
);
const noDocuments = { documents: {} as Record<string, DocumentBuffer> };
const noSubscription = () => () => {};
const emptyDocuments = () => noDocuments;
const fileViewId = (sessionId: string, path: string) => JSON.stringify(['files', sessionId, path]);

export function openedFilePaths(paths: string[], path: string): string[] | null {
  if (paths.includes(path)) return paths;
  return paths.length < 20 ? [...paths, path] : null;
}

export interface FileReference {
  path: string;
  start: number;
  end: number;
}
export const referenceText = ({ path, start, end }: FileReference) =>
  `@${path.includes(' ') ? JSON.stringify(path) : path}:L${start}${end === start ? '' : `-L${end}`}`;

export function FilePanel({
  projectId,
  sessionId,
  onReference,
}: {
  projectId: string;
  sessionId: string;
  onReference: (reference: FileReference) => void;
}) {
  const t = useTranslations('Desktop');
  const tf = useTranslations('Files');
  const te = useTranslations('Documents');
  const navigation = useSettingsNavigation();
  const { workspaces, mode, workspaceId } = useServices();
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
  const [saved, save] = useRemembered<{ paths: string[]; active: string | null }>(
    `corral:file-tabs:v1:${sessionId}:${scope?.kind ?? 'project'}`,
    { paths: [], active: null },
  );
  const paths = Array.isArray(saved?.paths)
    ? saved.paths.filter((p): p is string => typeof p === 'string').slice(0, 20)
    : [];
  const active =
    typeof saved?.active === 'string' && paths.includes(saved.active) ? saved.active : null;
  const [query, setQuery] = useState('');
  const [content, setContent] = useState<FileSideView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [documentKey, setDocumentKey] = useState<string | null>(null);
  const [retainedKey, setRetainedKey] = useState<string | null>(null);
  const [sessionRecoveries, setSessionRecoveries] = useState<RecoveryDraft[]>([]);
  const [recoveryReadError, setRecoveryReadError] = useState(false);
  const documentKeys = useRef(new Map<string, string>());
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
  const open = (path: string) => {
    const next = openedFilePaths(paths, path);
    if (!next) {
      setTabMessage(te('tabLimit'));
      return;
    }
    setTabMessage(null);
    save({ paths: next, active: path });
  };
  const removeTab = (path: string) => {
    const next = paths.filter((p) => p !== path);
    save({ paths: next, active: active === path ? (next.at(-1) ?? null) : active });
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
  const closeDialog = closing ? (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !closeBusy) setClosing(null);
      }}
    >
      <DialogPopup
        finalFocus={() =>
          panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
          panel.current?.querySelector<HTMLElement>('button') ??
          false
        }
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="flex flex-col gap-4 p-6"
      >
        <DialogTitle>{te('closeTitle', { path: closing.path })}</DialogTitle>
        <DialogDescription>{te('closeHint')}</DialogDescription>
        {closeError || documents[closing.key]?.pendingSave ? (
          <p role="alert" className="text-sm text-danger">
            {te('closeFailed')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              closeBusy ||
              !currentCopy(documents[closing.key]) ||
              Boolean(documents[closing.key]?.pendingSave && !documents[closing.key]?.canRetrySave)
            }
            onClick={() => void close(closing.path, 'save', closing.key)}
          >
            {te('saveClose')}
          </Button>
          <Button
            variant="outline"
            disabled={closeBusy || Boolean(documents[closing.key]?.pendingSave)}
            onClick={() => void close(closing.path, 'discard', closing.key)}
          >
            {te('discard')}
          </Button>
          <Button
            variant="ghost"
            disabled={closeBusy}
            onClick={() => void close(closing.path, 'cancel', closing.key)}
          >
            {te('cancel')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  ) : null;
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
                      open(candidate.path);
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
            readOnlyTarget
          />
        ) : null}
      </section>
    ) : null;
  if (!scope && !loading)
    return (
      <div ref={panel} className="space-y-2 p-3 text-xs text-muted">
        <TerminalPanel sessionId={sessionId} />
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
  return (
    <div ref={panel} className="flex min-h-0 flex-col gap-2" data-testid="file-panel">
      {retainedDrafts}
      {recoveryCandidates}
      {recoveryReadError ? (
        <p role="alert" className="text-xs text-danger">
          {te('recoveryReadFailed')}
        </p>
      ) : null}
      {scopeKind === 'session' ? (
        <PreviewLeases key={`previews:${sessionId}`} sessionId={sessionId} />
      ) : null}
      {scopeKind === 'session' ? <WorktreeCommandPanel sessionId={sessionId} /> : null}
      <TerminalPanel sessionId={sessionId} />
      {scopeKind === 'session' ? (
        <ServicePreview key={`service:${sessionId}`} sessionId={sessionId} />
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
      <Input
        aria-label={t('filterFiles')}
        placeholder={t('filterFiles')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
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
      {tabMessage ? (
        <p role="status" className="text-xs text-muted">
          {tabMessage}
        </p>
      ) : null}
      <div
        role="tablist"
        aria-label={t('openFiles')}
        className="flex overflow-x-auto border-b border-line"
      >
        {paths.map((path) => (
          <div
            key={path}
            className={`flex shrink-0 items-center border-r border-line ${active === path ? 'bg-raised' : ''}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active === path}
              tabIndex={active === path ? 0 : -1}
              onClick={() => open(path)}
              onKeyDown={(event) => {
                const index = paths.indexOf(path);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % paths.length
                    : event.key === 'ArrowLeft'
                      ? (index + paths.length - 1) % paths.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? paths.length - 1
                          : -1;
                const nextPath = paths[next];
                if (nextPath === undefined) return;
                event.preventDefault();
                open(nextPath);
                event.currentTarget
                  .closest('[role="tablist"]')
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
              className="max-w-40 truncate px-2 py-2 text-xs"
              title={path}
              aria-label={
                scopeKind === 'session' && buffered(path)?.dirty ? te('dirtyTab', { path }) : path
              }
            >
              {path}
              {scopeKind === 'session' && buffered(path)?.dirty ? (
                <span aria-hidden="true"> ●</span>
              ) : null}
            </button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('closeFile', { path })}
              onClick={() => void close(path)}
            >
              <X />
            </Button>
          </div>
        ))}
      </div>
      {readError ? (
        <p role="alert" className="text-xs text-danger">
          {readError}
        </p>
      ) : null}
      {active && !displayContent && !readError ? (
        <p className="text-xs text-muted">{t('loadingFile')}</p>
      ) : null}
      {active && canPreviewFile(active) && scopeKind === 'session' && mode === 'server' ? (
        <FilePreview key={`${sessionId}:${active}`} sessionId={sessionId} path={active} />
      ) : null}
      {scopeKind === 'session' &&
      owner &&
      documentKey &&
      documents[documentKey] &&
      (documents[documentKey].file.content.kind === 'text' ||
        documents[documentKey].dirty ||
        documents[documentKey].pendingSave ||
        documents[documentKey].recoveries.length) ? (
        <DocumentPanel
          key={documentKey}
          owner={owner}
          documentKey={documentKey}
          viewId={fileViewId(sessionId, documents[documentKey].path)}
          onReference={onReference}
          readOnlyTarget={!currentCopy(documents[documentKey])}
        />
      ) : displayContent?.kind === 'text' && active ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label>
              {t('fromLine')}{' '}
              <input
                type="number"
                min={1}
                max={lineCount}
                value={range.start}
                onChange={(e) => setRange((r) => ({ ...r, start: e.target.valueAsNumber || 1 }))}
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
      {closeDialog}
    </div>
  );
}
