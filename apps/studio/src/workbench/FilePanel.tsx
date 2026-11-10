import type { FileListView, FileSideView } from '@corral/client';
import type { TextAttachment, TextRange, WorkspaceTarget } from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  fontWeights,
  Input,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Select,
  Textarea,
  Tooltip,
} from '@corral/react/design-kit';
import { Ellipsis, RefreshCw, Search, X } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { useRemembered } from '../pages/Workbench.tsx';
import { useServices } from '../services.tsx';
import { formatChord } from '../shortcuts.ts';
import { ContentSearch } from './ContentSearch.tsx';
import type { AttachmentCapture } from './context/bridge.ts';
import { DocumentHeader, publishTreeSource } from './DocumentHeader.tsx';
import { DocumentPanel } from './DocumentPanel.tsx';
import { DocumentCloseDialog } from './documents/DocumentCloseDialog.tsx';
import type { RecoveryDraft } from './documents/recovery.ts';
import { type CloseChoice, type DocumentBuffer, documentStore } from './documents/store.ts';
import { FileTree } from './FileTree.tsx';
import { type FolderListing, needsListing, visibleRows } from './fileTree.ts';
import { LineRangePopover } from './LineRangePopover.tsx';
import { languageStore } from './language/store.ts';
import { useSettingsNavigation } from './navigation.ts';
import { openQuickOpen, takeFileReveal, useFileReveal } from './QuickOpen.tsx';
import { runResultFiles } from './runResults.ts';
import { useWorkspaceFiles } from './useWorkspaceFiles.ts';

const SourceCode = lazy(() =>
  import('./PierreCode.tsx').then((module) => ({ default: module.SourceCode })),
);
const noDocuments = { documents: {} as Record<string, DocumentBuffer> };
const noSubscription = () => () => {};
const emptyDocuments = () => noDocuments;
const fileViewId = (sessionId: string, path: string) => JSON.stringify(['files', sessionId, path]);
const noPaths: ReadonlySet<string> = new Set();
const noListings: ReadonlyMap<string, FolderListing> = new Map();
const noRuns: readonly RunSummary[] = [];
const parentsOf = (path: string) =>
  path
    .split('/')
    .slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join('/'));
const toggled = (paths: ReadonlySet<string>, path: string, on: boolean) => {
  const next = new Set(paths);
  if (on) next.add(path);
  else next.delete(path);
  return next;
};
/** Folder listings read for one root listing of one scope; a refresh starts again. */
interface FolderReads {
  base: FileListView;
  scopeKey: string;
  listings: ReadonlyMap<string, FolderListing>;
  loading: ReadonlySet<string>;
  failed: ReadonlySet<string>;
}
const freshReads = (base: FileListView, scopeKey: string): FolderReads => ({
  base,
  scopeKey,
  listings: noListings,
  loading: noPaths,
  failed: noPaths,
});

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
  readOnly = false,
  runs = noRuns,
}: {
  projectId: string;
  sessionId: string;
  /** The session's runs, oldest first: a result file names its run by its number among them. */
  runs?: readonly RunSummary[];
  onReference: (reference: FileReference) => void;
  onAttach?: (attachment: TextAttachment, capture: AttachmentCapture) => void | Promise<void>;
  onOpenDocument?: (document: OpenDocumentRequest, range?: TextRange) => boolean;
  /** Browse only the original folder, with inline previews and no document actions. */
  readOnly?: boolean;
}) {
  const t = useTranslations('Desktop');
  const tf = useTranslations('Files');
  const tq = useTranslations('QuickOpen');
  const te = useTranslations('Documents');
  const td = useTranslations('Docking');
  const ts = useTranslations('ContentSearch');
  const tw = useTranslations('Workbench');
  const sessionText = useTranslations('Sessions');
  const navigation = useSettingsNavigation();
  const services = useServices();
  const { workspaces, mode, workspaceId } = services;
  const owner = !readOnly && workspaces && mode === 'server' ? documentStore(workspaces) : null;
  const { documents } = useSyncExternalStore(
    owner?.subscribe ?? noSubscription,
    owner?.getState ?? emptyDocuments,
    emptyDocuments,
  );
  const [savedSource, setSource] = useRemembered<'project' | 'session' | null>(
    `corral:file-source:v1:${sessionId}`,
    null,
  );
  const source = readOnly
    ? 'project'
    : savedSource === 'project' || savedSource === 'session'
      ? savedSource
      : undefined;
  const { scope, list, hasCopy, copy, loading, error, refresh } = useWorkspaceFiles(
    projectId,
    sessionId,
    source,
  );
  const [saved, setPreview] = useRemembered<string | null>(
    `corral:file-preview:v1:${sessionId}:${readOnly ? 'project-viewer' : (scope?.kind ?? 'project')}`,
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
  const [referenceOpen, setReferenceOpen] = useState(false);
  const previewMore = useRef<HTMLButtonElement>(null);
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
  const panel = useRef<HTMLDivElement>(null);
  // The tree: the root listing, plus each incomplete folder's own listing once it is expanded.
  const scopeKey = scope ? `${scope.kind}:${scope.id}` : '';
  const [reads, setReads] = useState<FolderReads>(() => freshReads(list, scopeKey));
  const folders =
    reads.base === list && reads.scopeKey === scopeKey ? reads : freshReads(list, scopeKey);
  const [opened, setOpened] = useState({ scopeKey, paths: noPaths });
  const expanded = opened.scopeKey === scopeKey ? opened.paths : noPaths;
  // The Results filter: only the session copy has run writes to attribute.
  const [resultsOn, setResultsOn] = useState(false);
  const resultsAvailable = !readOnly && scope?.kind === 'session';
  const results = resultsOn && resultsAvailable;
  const runKey = runs.map((run) => `${run.runId}:${run.status}`).join(',');
  const madeKey = `${scopeKey}:${runKey}`;
  /** `files` is null when the records could not be read: nothing is then attributed. */
  const [made, setMade] = useState<{ key: string; files: ReadonlyMap<string, string> | null }>();
  const madeFiles = made?.key === madeKey ? made.files : undefined;
  useEffect(() => {
    // A tree refresh or a run's start or end reads the records again.
    void list;
    if (!results || !workspaces) return;
    let live = true;
    const key = madeKey;
    void Promise.all([
      workspaces.fileOperations(sessionId),
      workspaces.changes(sessionId, { kind: 'session' }),
    ]).then(
      ([operations, changes]) => {
        if (live) setMade({ key, files: runResultFiles(operations, changes.files) });
      },
      () => {
        if (live) setMade({ key, files: null });
      },
    );
    return () => {
      live = false;
    };
  }, [results, workspaces, sessionId, madeKey, list]);
  const only = useMemo(
    () => (results ? new Set(madeFiles?.keys() ?? []) : undefined),
    [results, madeFiles],
  );
  const runNotes = useMemo(() => {
    if (!results || !madeFiles) return undefined;
    const notes = new Map<string, string>();
    for (const [path, runId] of madeFiles) {
      // The same number the run's status pill shows.
      const number = runs.findIndex((run) => run.runId === runId) + 1;
      if (number) notes.set(path, tw('runNumber', { number }));
    }
    return notes;
  }, [results, madeFiles, runs, tw]);
  const filterKey = `${results ? 'results' : ''}:${query}`;
  const [filterClosed, setFilterClosed] = useState({ key: ':', paths: noPaths });
  const collapsed = filterClosed.key === filterKey ? filterClosed.paths : noPaths;
  const filtering = Boolean(query.trim()) || results;
  const listings = useMemo(
    () => new Map<string, FolderListing>([['', list], ...folders.listings]),
    [list, folders.listings],
  );
  const treeRows = useMemo(
    () =>
      visibleRows(listings, {
        expanded,
        query,
        ...(only ? { only } : {}),
        collapsed,
        loading: folders.loading,
        failed: folders.failed,
      }),
    [listings, expanded, query, only, collapsed, folders.loading, folders.failed],
  );
  // Folders to read: the expanded ones, and while filtering for results, each result's folder.
  const reading = useMemo(() => {
    const paths = new Set(expanded);
    for (const path of only ?? []) {
      const folder = parentsOf(path).at(-1);
      if (folder) paths.add(folder);
    }
    return paths;
  }, [expanded, only]);
  useEffect(() => {
    if (!workspaces || !scope) return;
    const wanted = [...reading].filter(
      (path) =>
        needsListing(path, listings) && !folders.loading.has(path) && !folders.failed.has(path),
    );
    if (!wanted.length) return;
    const base = list;
    const key = scopeKey;
    // A read answers only the listing and scope it was asked for.
    const current = (state: FolderReads) => state.base === base && state.scopeKey === key;
    setReads((state) => {
      const start = current(state) ? state : freshReads(base, key);
      return { ...start, loading: new Set([...start.loading, ...wanted]) };
    });
    for (const path of wanted)
      void workspaces.listFiles(scope, path).then(
        (view) =>
          setReads((state) =>
            current(state)
              ? {
                  ...state,
                  listings: new Map(state.listings).set(path, view),
                  loading: toggled(state.loading, path, false),
                }
              : state,
          ),
        () =>
          setReads((state) =>
            current(state)
              ? {
                  ...state,
                  loading: toggled(state.loading, path, false),
                  failed: toggled(state.failed, path, true),
                }
              : state,
          ),
      );
  }, [workspaces, scope, scopeKey, list, reading, listings, folders.loading, folders.failed]);
  const toggleFolder = (path: string, open: boolean) => {
    if (filtering)
      setFilterClosed((state) => ({
        key: filterKey,
        paths: toggled(state.key === filterKey ? state.paths : noPaths, path, !open),
      }));
    else
      setOpened((state) => ({
        scopeKey,
        paths: toggled(state.scopeKey === scopeKey ? state.paths : noPaths, path, open),
      }));
    // Opening a folder that could not be read reads it again.
    if (open && folders.failed.has(path))
      setReads((state) => ({ ...state, failed: toggled(state.failed, path, false) }));
  };
  const removeTab = (path: string) => {
    if (active === path) setPreview(null);
    setTabMessage(null);
  };
  const scopeKind = scope?.kind;
  const scopeId = scope?.id;
  // The tree's select names its source; a document head beside it then names only another one.
  useEffect(
    () =>
      scopeKind
        ? publishTreeSource(sessionId, scopeKind === 'session' ? 'copy' : 'source')
        : undefined,
    [sessionId, scopeKind],
  );
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
  // Quick open shows a folder, or a source-folder file, here: in its tree, under its source.
  const reveal = useFileReveal(sessionId, !readOnly);
  const [revealed, setRevealed] = useState<{ path: string; seq: number } | null>(null);
  const switching = useRef<{ seq: number; scope: typeof scope } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per request, when its source is the one listed.
  useEffect(() => {
    if (!reveal || loading) return;
    if (scopeKind !== reveal.source) {
      // The tree lists the request's source first; a source still missing once it was read
      // again drops the request.
      if (switching.current?.seq === reveal.seq) {
        if (switching.current.scope !== scope) takeFileReveal(reveal.seq);
      } else if (savedSource === reveal.source) takeFileReveal(reveal.seq);
      else {
        switching.current = { seq: reveal.seq, scope };
        setSource(reveal.source);
      }
      return;
    }
    takeFileReveal(reveal.seq);
    setQuery('');
    setSearchMode('names');
    setOpened((state) => ({
      scopeKey,
      paths: new Set([
        ...(state.scopeKey === scopeKey ? state.paths : noPaths),
        ...parentsOf(reveal.path),
        ...(reveal.kind === 'folder' ? [reveal.path] : []),
      ]),
    }));
    setRevealed({ path: reveal.path, seq: reveal.seq });
    if (reveal.kind === 'file') void open(reveal.path);
  }, [reveal, loading, scopeKind, scopeKey, savedSource]);
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
        <p className="text-body" style={{ fontVariationSettings: fontWeights.semibold }}>
          {te('recovery')}
        </p>
        {candidates.map((candidate) => {
          const sameCopy = Boolean(
            copy &&
              !copy.missing &&
              !copy.removedAt &&
              candidate.target.bindingId === copy.bindingId &&
              candidate.target.copyGeneration === copy.copyGeneration,
          );
          return (
            <details key={candidate.id} className="min-w-0 text-caption">
              <summary
                className="cursor-pointer break-all py-2"
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {candidate.path}
              </summary>
              <p className="mb-2 text-muted-foreground">
                {te(sameCopy ? 'recoveryHint' : 'previousCopyHint')}
              </p>
              <Textarea
                readOnly
                aria-label={te('draftContent')}
                value={candidate.text}
                className="font-mono text-caption"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {sameCopy ? (
                  <Button
                    size="compact"
                    variant="tertiary"
                    onClick={() => {
                      setSource('session');
                      void open(candidate.path, true);
                    }}
                  >
                    {te('openRecoveryFile')}
                  </Button>
                ) : null}
                <Button
                  size="compact"
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
        <p className="text-body" style={{ fontVariationSettings: fontWeights.semibold }}>
          {te(scope ? 'previousCopy' : 'preservedDrafts')}
        </p>
        <p className="text-caption text-muted-foreground">
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
              size="icon-compact"
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
  const fileSetup =
    scope?.kind === 'project' && !hasCopy && !loading ? (
      <Banner status="info" role="note" size="compact">
        <BannerTitle>{tf('noCopyReadOnly')}</BannerTitle>
        <BannerActions>
          <Button
            variant="tertiary"
            size="compact"
            render={
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId }}
                search={{ panel: 'changes' }}
              />
            }
          >
            {sessionText('prepareWorkingCopy')}
          </Button>
        </BannerActions>
      </Banner>
    ) : null;
  if (!scope && !loading)
    return (
      <div ref={panel} className="space-y-2 p-3 text-caption text-muted-foreground">
        {retainedDrafts}
        {recoveryCandidates}
        {recoveryReadError ? <p role="alert">{te('recoveryReadFailed')}</p> : null}
        {closeDialog}
        {error ? <p role="alert">{error}</p> : <p>{t('linkToBrowse')}</p>}
        <Link {...navigation.link('workspace', projectId)} className="text-primary underline">
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
  const closeButton = (path: string) => (
    <Tooltip content={t('closeFile', { path })}>
      <Button
        size="icon-compact"
        variant="ghost"
        aria-label={t('closeFile', { path })}
        onClick={() => void close(path)}
      >
        <X />
      </Button>
    </Tooltip>
  );
  const searchModeControl = (
    <Select
      label={ts('mode')}
      size="xs"
      className="min-w-0 max-w-full shrink-0"
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
    <div
      ref={panel}
      // Only the tree gives up height in a short pane; everything else keeps its own.
      className="flex min-h-0 flex-1 flex-col gap-2 [&>:not([role=tree])]:shrink-0"
      data-testid="file-panel"
    >
      {fileSetup}
      {retainedDrafts}
      {recoveryCandidates}
      {recoveryReadError ? (
        <p role="alert" className="text-caption text-danger">
          {te('recoveryReadFailed')}
        </p>
      ) : null}
      {/* The head in two rows: where the tree reads from with the panel's own tools, then what
          narrows the tree: the filter, how it matches and the Results filter (in contents
          mode, which replaces the tree, the content search takes the second row). */}
      <div className="flex min-w-0 items-center gap-2">
        {readOnly ? (
          <span className="min-w-0 truncate text-caption text-muted-foreground">
            {t('sourceFolder')}
          </span>
        ) : (
          <Select
            label={t('fileSource')}
            size="xs"
            variant="ghost"
            className="min-w-0 justify-start"
            value={scopeKind ?? 'project'}
            onValueChange={setSource}
            options={[
              { value: 'project' as const, label: t('sourceFolder') },
              ...(hasCopy ? [{ value: 'session' as const, label: t('sessionCopy') }] : []),
            ]}
          />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {readOnly ? null : (
            <Tooltip content={tq('title')} shortcut={formatChord({ mod: true, key: 'p' })}>
              <Button
                size="icon-compact"
                variant="ghost"
                aria-label={tq('title')}
                aria-keyshortcuts={
                  /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta+P' : 'Control+P'
                }
                onClick={openQuickOpen}
              >
                <Search />
              </Button>
            </Tooltip>
          )}
          <Tooltip content={t('refreshFiles')}>
            <Button
              size="icon-compact"
              variant="ghost"
              aria-label={t('refreshFiles')}
              onClick={refresh}
            >
              <RefreshCw />
            </Button>
          </Tooltip>
        </div>
      </div>
      {readOnly || searchMode === 'names' ? (
        // One row in any width the panel takes: the field gives up its width, never its row.
        <div className="flex min-w-0 items-center gap-2">
          {readOnly ? null : searchModeControl}
          <Input
            size="sm"
            aria-label={t('filterFiles')}
            placeholder={t('filterFiles')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1"
          />
          {resultsAvailable ? (
            <Button
              size="compact"
              variant={results ? 'secondary' : 'ghost'}
              aria-pressed={results}
              className="shrink-0"
              onClick={() => setResultsOn(!resultsOn)}
            >
              {tf('results')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!readOnly && searchMode === 'contents' ? (
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
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {searchModeControl}
              <Input
                size="sm"
                disabled
                placeholder={ts('placeholder')}
                aria-label={ts('placeholder')}
                className="min-w-0 max-w-full flex-[1_0_10rem]"
              />
            </div>
            <p className="text-caption text-muted-foreground">
              {ts(hasCopy ? 'needsCopy' : 'needsCopyPreparation')}
            </p>
            {hasCopy && scopeKind === 'project' ? (
              <Button
                size="compact"
                variant="tertiary"
                className="self-start"
                onClick={() => setSource('session')}
              >
                {ts('selectCopy')}
              </Button>
            ) : !hasCopy ? (
              <Button
                size="compact"
                variant="tertiary"
                className="self-start"
                render={
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId }}
                    search={{ panel: 'changes' }}
                  />
                }
              >
                {ts('prepareCopy')}
              </Button>
            ) : null}
          </div>
        )
      ) : null}
      {readOnly || searchMode === 'names' ? (
        <>
          {results && madeFiles === null ? (
            <p role="alert" className="p-2 text-caption text-danger">
              {tf('resultsFailed')}
            </p>
          ) : treeRows.length ? (
            <FileTree
              label={tf('tree')}
              rows={treeRows}
              active={active}
              onOpen={(path) => void open(path)}
              onToggle={toggleFolder}
              reveal={revealed}
              {...(runNotes ? { notes: runNotes } : {})}
            />
          ) : results && madeFiles === undefined ? (
            <p className="p-2 text-caption text-muted-foreground">{tf('folderLoading')}</p>
          ) : results ? (
            <p className="p-2 text-caption text-muted-foreground">{tf('noResultFiles')}</p>
          ) : !loading ? (
            <p className="p-2 text-caption text-muted-foreground">{t('noFiles')}</p>
          ) : null}
          {list.truncated ? (
            <p role="note" className="text-caption text-muted-foreground">
              {t('filesTruncated')}
            </p>
          ) : null}
        </>
      ) : null}
      {tabMessage ? (
        <p role="status" className="text-caption text-muted-foreground">
          {tabMessage}
        </p>
      ) : null}
      {active ? (
        <section
          data-testid="file-preview-pane"
          aria-label={active}
          className="flex min-w-0 flex-col overflow-hidden rounded-[var(--panel-radius)] border border-border"
        >
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
              edits={
                services.mode === 'server' && services.workspaces?.fileEditProposals
                  ? services.workspaces
                  : undefined
              }
              viewId={fileViewId(sessionId, documents[documentKey].path)}
              onReference={onReference}
              onAttach={onAttach}
              readOnlyTarget={!currentCopy(documents[documentKey])}
              headExtra={closeButton(active)}
            />
          ) : (
            <>
              <DocumentHeader
                path={active}
                treeSource={scopeKind === 'session' ? 'copy' : 'source'}
                target={
                  scopeKind === 'session' && searchTarget
                    ? { kind: 'copy', target: searchTarget }
                    : { kind: 'source' }
                }
                status={
                  <span className="truncate @max-xl/head:sr-only">{tf('readOnlyPreview')}</span>
                }
                actions={
                  displayContent?.kind === 'text' ? (
                    <Menu>
                      <Tooltip content={te('moreActions', { path: active })}>
                        <MenuTrigger
                          ref={previewMore}
                          render={
                            <Button
                              variant="ghost"
                              size="icon-compact"
                              aria-label={te('moreActions', { path: active })}
                            />
                          }
                        >
                          <Ellipsis />
                        </MenuTrigger>
                      </Tooltip>
                      <MenuPopup align="end" className="min-w-48">
                        <MenuItem
                          onClick={() => requestAnimationFrame(() => setReferenceOpen(true))}
                        >
                          {te('referenceLinesMenu')}
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  ) : null
                }
              >
                {closeButton(active)}
              </DocumentHeader>
              {readError ? (
                <p role="alert" className="px-3 py-2 text-caption text-danger">
                  {readError}
                </p>
              ) : null}
              {!displayContent && !readError ? (
                <p className="px-3 py-2 text-caption text-muted-foreground">{t('loadingFile')}</p>
              ) : null}
              {displayContent?.kind === 'text' ? (
                <>
                  <section aria-label={t('fileContent')} className="max-h-[45vh] overflow-auto">
                    <Suspense
                      fallback={
                        <p className="p-3 text-caption text-muted-foreground">{t('loadingFile')}</p>
                      }
                    >
                      <SourceCode path={active} text={displayContent.text} onSelect={setRange} />
                    </Suspense>
                  </section>
                  <LineRangePopover
                    open={referenceOpen}
                    onOpenChange={setReferenceOpen}
                    anchor={previewMore}
                    action={t('referenceLines')}
                    range={range}
                    lineCount={lineCount}
                    onRange={setRange}
                    note={t('referencePermission')}
                    onSubmit={(value) => {
                      onReference({ path: active, ...value });
                      setReferenceOpen(false);
                    }}
                  />
                </>
              ) : displayContent ? (
                <p className="px-3 py-2 text-caption text-muted-foreground">
                  {displayContent.kind === 'too_large'
                    ? tf('tooLarge')
                    : displayContent.kind === 'binary'
                      ? tf('binary')
                      : t('fileUnavailable')}
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      {closeDialog}
    </div>
  );
}
