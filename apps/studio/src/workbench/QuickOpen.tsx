import type { FileBrowseScope, PathSearchView } from '@corral/client';
import {
  Badge,
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuInput,
  CommandMenuItem,
  type CommandMenuItemData,
  CommandMenuList,
  fontWeights,
} from '@corral/react/design-kit';
import { FileText, Folder } from '@corral/react/icons';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { useRegisterCommands } from '../commandRegistry.ts';
import { useServices } from '../services.tsx';
import { formatChord } from '../shortcuts.ts';
import { documentStore } from './documents/store.ts';
import type { OpenDocumentRequest } from './FilePanel.tsx';
import { settingsInteractionBlocked } from './navigation.ts';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

// Quick open (⌘P / Ctrl+P): find a file or folder of the session's current target by path. The
// built-in path search ranks the candidates; a result is only ever a path that search returned
// for the target shown beside the input. See docs/specs/features/file-search.md.

const OPEN_QUICK_OPEN = 'corral:quick-open';
const LIMIT = 50;
const CHORD = { mod: true, key: 'p' } as const;

/** Opens quick open from anywhere in the session, such as the Files tree head. */
export function openQuickOpen() {
  window.dispatchEvent(new Event(OPEN_QUICK_OPEN));
}

/** A folder, or a source-folder file, shown in the Files tree instead of a document tab. */
export interface FileRevealRequest {
  sessionId: string;
  source: 'project' | 'session';
  path: string;
  kind: 'file' | 'folder';
}
let reveal: (FileRevealRequest & { seq: number }) | null = null;
let revealSeq = 0;
const revealListeners = new Set<() => void>();
const subscribeReveal = (listener: () => void) => {
  revealListeners.add(listener);
  return () => revealListeners.delete(listener);
};
/** Held until the Files pane of that session takes it, so a pane that opens next still sees it. */
export function requestFileReveal(request: FileRevealRequest) {
  reveal = { ...request, seq: ++revealSeq };
  for (const listener of revealListeners) listener();
}
export function takeFileReveal(seq: number) {
  if (reveal?.seq !== seq) return;
  reveal = null;
  for (const listener of revealListeners) listener();
}
export function useFileReveal(sessionId: string, enabled = true) {
  const pending = useSyncExternalStore(
    subscribeReveal,
    () => reveal,
    () => null,
  );
  return enabled && pending?.sessionId === sessionId ? pending : null;
}

type Target = { key: string; source: 'session' | 'project'; scope: FileBrowseScope };

/**
 * Which characters of a path the typed text matched: the text itself in the name, else in the
 * path, else its characters in order. Display only; the search already ranked the result.
 */
export function matchedIndexes(path: string, query: string): Set<number> {
  const needle = query.trim().toLowerCase();
  const hay = path.toLowerCase();
  const found = new Set<number>();
  if (!needle) return found;
  const nameStart = path.lastIndexOf('/') + 1;
  const inName = hay.indexOf(needle, nameStart);
  const at = inName >= 0 ? inName : hay.indexOf(needle);
  if (at >= 0) {
    for (let index = at; index < at + needle.length; index++) found.add(index);
    return found;
  }
  let from = 0;
  for (const char of needle) {
    const index = hay.indexOf(char, from);
    if (index < 0) return new Set();
    found.add(index);
    from = index + 1;
  }
  return found;
}

/** A path with its folder quiet and its name plain, and the typed characters emphasized. */
function PathLabel({ path, query }: { path: string; query: string }) {
  const matched = matchedIndexes(path, query);
  const nameStart = path.lastIndexOf('/') + 1;
  const part = (from: number, to: number) => {
    const runs: { start: number; text: string; hit: boolean }[] = [];
    for (let index = from; index < to; index++) {
      const hit = matched.has(index);
      const last = runs.at(-1);
      if (last && last.hit === hit) last.text += path[index];
      else runs.push({ start: index, text: path[index] ?? '', hit });
    }
    return runs.map((run) =>
      run.hit ? (
        <span
          key={run.start}
          className="text-foreground"
          style={{ fontVariationSettings: fontWeights.bold }}
        >
          {run.text}
        </span>
      ) : (
        <span key={run.start}>{run.text}</span>
      ),
    );
  };
  return (
    <span className="flex min-w-0 flex-1 items-baseline">
      {nameStart ? (
        <span className="min-w-0 truncate text-muted-foreground">{part(0, nameStart)}</span>
      ) : null}
      <span className="min-w-0 max-w-full shrink-0 truncate text-foreground">
        {part(nameStart, path.length)}
      </span>
    </span>
  );
}

export function QuickOpen({
  projectId,
  sessionId,
  openDocument,
  showInFiles,
}: {
  projectId: string;
  sessionId: string;
  /** Opens a working-copy file as a document tab, or shows the tab it already has. */
  openDocument: (document: OpenDocumentRequest) => boolean;
  showInFiles: (request: FileRevealRequest) => void;
}) {
  const t = useTranslations('QuickOpen');
  const td = useTranslations('Desktop');
  const tcmd = useTranslations('Commands');
  const { workspaces, mode } = useServices();
  const owner = workspaces && mode === 'server' ? documentStore(workspaces) : null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // undefined while the target is read; null when the session has none.
  const [target, setTarget] = useState<Target | null | undefined>(undefined);
  const [found, setFound] = useState<{ key: string; query: string; view: PathSearchView } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [targetTick, setTargetTick] = useState(0);
  const searches = useRef(0);
  const opens = useRef(0);
  const statusId = useId();
  const targetId = useId();
  const show = (next: boolean) => {
    setOpen(next);
    if (next) return;
    // A closed dialog keeps nothing in flight: late answers and opens are dropped, and the
    // target is read again on the next open.
    searches.current++;
    opens.current++;
    setTarget(undefined);
    setQuery('');
    setFound(null);
    setError(null);
    setOpening(false);
  };
  const showRef = useRef(show);
  showRef.current = show;
  const openRef = useRef(open);
  openRef.current = open;

  useRegisterCommands('quick-open', [
    {
      id: 'files:quick-open',
      title: t('title'),
      group: tcmd('groups.panel'),
      keywords: ['file', 'path', 'go to file', 'find file'],
      shortcut: formatChord(CHORD),
      disabled: !workspaces,
      run: () => showRef.current(true),
    },
  ]);
  useEffect(() => {
    const request = () => showRef.current(true);
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229)
        return;
      const mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
      if (!(mac ? event.metaKey : event.ctrlKey) || (mac ? event.ctrlKey : event.metaKey)) return;
      if (event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'p' && event.code !== 'KeyP') return;
      if (settingsInteractionBlocked()) return;
      event.preventDefault();
      showRef.current(!openRef.current);
    };
    const changed = () => setTargetTick((value) => value + 1);
    window.addEventListener(OPEN_QUICK_OPEN, request);
    window.addEventListener('keydown', onKey);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => {
      window.removeEventListener(OPEN_QUICK_OPEN, request);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(WORKSPACE_CHANGED, changed);
    };
  }, []);

  // The target: the session's working copy, or the project's source folder without one.
  useEffect(() => {
    void targetTick;
    if (!open || !workspaces) return;
    let live = true;
    void (async (): Promise<Target | null> => {
      const copy = await workspaces.worktree(sessionId).catch(() => null);
      if (copy && !copy.missing && !copy.removedAt)
        return {
          key: `session:${sessionId}:${copy.bindingId}:${copy.copyGeneration}`,
          source: 'session',
          scope: { kind: 'session', id: sessionId },
        };
      const binding = await workspaces.binding(projectId).catch(() => null);
      return binding && !binding.missing
        ? {
            key: `project:${projectId}`,
            source: 'project',
            scope: { kind: 'project', id: projectId },
          }
        : null;
    })().then((next) => {
      if (live)
        setTarget((current) => (current && next && current.key === next.key ? current : next));
    });
    return () => {
      live = false;
    };
  }, [open, workspaces, sessionId, projectId, targetTick]);

  useEffect(() => {
    if (!open || !workspaces || !target) return;
    const id = ++searches.current;
    void workspaces.searchFiles(target.scope, query, LIMIT).then(
      (view) => {
        if (searches.current !== id) return;
        setFound({ key: target.key, query, view });
        setError(null);
      },
      (failure: unknown) => {
        if (searches.current !== id) return;
        setFound(null);
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  }, [open, workspaces, target, query]);

  // An open that finishes after the target changed, or after quick open is gone, opens nothing.
  const targetKey = target?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A completed read must not open into another target or a departed session.
  useEffect(
    () => () => {
      opens.current++;
      setOpening(false);
    },
    [targetKey],
  );

  // Only what the server returned for the target on screen now and the text typed now.
  const results =
    target && found?.key === target.key && found.query === query ? found.view.items : [];
  const items: CommandMenuItemData[] = results.map((item) => ({
    value: `${item.kind}:${item.path}`,
    label: item.path,
    icon: item.kind === 'folder' ? Folder : FileText,
  }));
  const choose = async (value: string) => {
    const item = results.find((entry) => `${entry.kind}:${entry.path}` === value);
    if (!item || !target || opening) return;
    if (item.kind === 'folder' || target.source === 'project') {
      showInFiles({ sessionId, source: target.source, path: item.path, kind: item.kind });
      show(false);
      return;
    }
    if (!owner) return;
    const id = ++opens.current;
    setOpening(true);
    setError(null);
    try {
      const key = await owner.open(sessionId, item.path);
      if (opens.current !== id) return;
      const document = owner.getState().documents[key];
      if (!document) throw new Error(t('openFailed', { path: item.path }));
      openDocument({ documentKey: key, target: document.target, path: document.path });
      show(false);
    } catch (failure) {
      if (opens.current !== id) return;
      setOpening(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const searching =
    target === undefined ||
    (target !== null && (found?.key !== target.key || found.query !== query));
  const announcement =
    target === null
      ? t('noTarget')
      : error
        ? error
        : searching && !results.length
          ? t('searching')
          : t('results', { count: results.length });
  const targetLabel = target
    ? td(target.source === 'session' ? 'sessionCopy' : 'sourceFolder')
    : '';
  return (
    <CommandMenuDialog
      open={open}
      onOpenChange={show}
      shortcut={null}
      title={t('title')}
      description={t('description')}
    >
      <CommandMenu
        items={items}
        query={query}
        onQueryChange={setQuery}
        filter={() => true}
        closeOnSelect={false}
        onSelect={(item) => void choose(item.value)}
      >
        <div className="flex min-w-0 items-center pr-4 [&>[data-slot=command-menu-input]]:min-w-0 [&>[data-slot=command-menu-input]]:flex-1">
          <CommandMenuInput
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            aria-describedby={`${targetId} ${statusId}`}
            aria-busy={opening || undefined}
          />
          {targetLabel ? (
            <Badge id={targetId} variant="secondary" size="sm" className="shrink-0">
              {targetLabel}
            </Badge>
          ) : (
            <span id={targetId} />
          )}
        </div>
        <span id={statusId} role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
        <CommandMenuList
          renderItem={(item) => (
            // Every result reads at full strength; the highlight marks the one Enter opens.
            // The row keeps the folder or file icon from its item.
            <CommandMenuItem value={item.value} className="text-foreground">
              <PathLabel path={item.label} query={query} />
            </CommandMenuItem>
          )}
        >
          <CommandMenuEmpty role="none" aria-live="off">
            {target === null
              ? t('noTarget')
              : error
                ? error
                : searching
                  ? t('searching')
                  : t('empty')}
          </CommandMenuEmpty>
        </CommandMenuList>
        {error && results.length ? (
          <p role="alert" className="px-4 py-2 text-caption text-danger">
            {error}
          </p>
        ) : null}
      </CommandMenu>
    </CommandMenuDialog>
  );
}
