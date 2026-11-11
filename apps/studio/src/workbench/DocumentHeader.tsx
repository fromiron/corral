import type { GitStatus, WorkspaceTarget } from '@corral/contracts';
import { Badge, Tooltip } from '@corral/react/design-kit';
import { Files, Folder, GitBranch } from '@corral/react/icons';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

// Every open document's tab reads the branch at once; one Git status read answers them all.
const reads = new Map<string, Promise<GitStatus>>();

type Source = 'source' | 'copy';
// Which source a session's file tree shows while it is on screen. A document head beside it
// names its own source only when it differs: the tree's select already names the same one.
const treeSources = new Map<string, { kind: Source; token: symbol }>();
const treeListeners = new Set<() => void>();
const subscribeTree = (listener: () => void) => {
  treeListeners.add(listener);
  return () => treeListeners.delete(listener);
};
/** The file tree of a session says which source it shows; the returned function withdraws it. */
export function publishTreeSource(sessionId: string, kind: Source) {
  const token = Symbol(sessionId);
  treeSources.set(sessionId, { kind, token });
  for (const listener of treeListeners) listener();
  return () => {
    if (treeSources.get(sessionId)?.token !== token) return;
    treeSources.delete(sessionId);
    for (const listener of treeListeners) listener();
  };
}
function useTreeSource(sessionId: string | null) {
  return useSyncExternalStore(
    subscribeTree,
    () => (sessionId ? (treeSources.get(sessionId)?.kind ?? null) : null),
    () => null,
  );
}

/** The copy's current branch, or null when it is unknown, detached or of another copy. */
function useCopyBranch(target: WorkspaceTarget | null) {
  const { workspaces } = useServices();
  const [branch, setBranch] = useState<{ key: string; name: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const changed = () => setTick((value) => value + 1);
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  const sessionId = target?.sessionId;
  const key = target ? `${target.sessionId}:${target.bindingId}:${target.copyGeneration}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: The target is read through its key; a new object for the same copy reads nothing again.
  useEffect(() => {
    void tick;
    if (!sessionId || !workspaces?.gitStatus || !target) return;
    let live = true;
    let read = reads.get(sessionId);
    if (!read) {
      read = workspaces.gitStatus({ kind: 'session', id: sessionId });
      reads.set(sessionId, read);
      const settled = read;
      void read.then(
        () => reads.get(sessionId) === settled && reads.delete(sessionId),
        () => reads.get(sessionId) === settled && reads.delete(sessionId),
      );
    }
    void read.then(
      (status) => {
        if (!live) return;
        const same =
          status.target.kind === 'session' &&
          status.target.bindingId === target.bindingId &&
          status.target.copyGeneration === target.copyGeneration;
        setBranch({ key, name: same ? status.head.branch : null });
      },
      () => {
        if (live) setBranch({ key, name: null });
      },
    );
    return () => {
      live = false;
    };
  }, [workspaces, sessionId, key, tick]);
  return branch?.key === key ? branch.name : null;
}

/** The unsaved mark: a dot, and its words while the head has room for them. */
export function UnsavedMark({ label }: { label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emphasis" />
      <span className="truncate @max-lg/head:sr-only">{label}</span>
    </span>
  );
}

/**
 * A document's one-row head: its path, where it opened from (the session working copy or the
 * project source folder) when the file tree beside it shows another source, the copy's branch
 * and its save state, then its actions. A narrow head keeps the marks and moves their words into
 * tooltips.
 */
export function DocumentHeader({
  path,
  target,
  treeSource,
  unsaved = false,
  status,
  actions,
  children,
}: {
  path: string;
  target: { kind: 'source' } | { kind: 'copy'; target: WorkspaceTarget };
  /** The source the file tree beside this head shows; by default, its session's tree's. */
  treeSource?: Source;
  unsaved?: boolean;
  /** The save state; without it, an unsaved document still shows its mark. */
  status?: ReactNode;
  /** Controls at the row's end, such as Save and the more menu. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const td = useTranslations('Desktop');
  const tf = useTranslations('Files');
  const tdoc = useTranslations('Documents');
  const branch = useCopyBranch(target.kind === 'copy' ? target.target : null);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const folder = path.slice(0, path.length - name.length);
  const source = td(target.kind === 'copy' ? 'sessionCopy' : 'sourceFolder');
  const SourceIcon = target.kind === 'copy' ? Files : Folder;
  const published = useTreeSource(target.kind === 'copy' ? target.target.sessionId : null);
  const beside = treeSource ?? published;
  return (
    <div
      data-testid="document-header"
      className="@container/head flex h-10 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 text-caption text-muted-foreground"
    >
      {/* The folder gives way first, so the file name stays readable. */}
      <p className="flex min-w-0 flex-1 items-center font-mono text-body" title={path}>
        {folder ? <span className="min-w-0 truncate">{folder}</span> : null}
        <span className="min-w-0 max-w-full shrink-0 truncate text-foreground">{name}</span>
      </p>
      {beside === target.kind ? null : (
        <Tooltip content={source}>
          <Badge variant="secondary" size="sm" className="shrink-0">
            <span className="inline-flex items-center gap-1">
              <SourceIcon aria-hidden className="size-3 shrink-0" />
              <span className="@max-xl/head:sr-only">{source}</span>
            </span>
          </Badge>
        </Tooltip>
      )}
      {branch ? (
        <Tooltip content={tf('branch', { branch })}>
          <span className="inline-flex min-w-0 max-w-40 shrink items-center gap-1">
            <GitBranch size={12} aria-hidden className="shrink-0" />
            <span className="sr-only">{tf('branch', { branch })}</span>
            <span aria-hidden className="truncate @max-lg/head:hidden">
              {branch}
            </span>
          </span>
        </Tooltip>
      ) : null}
      {status ?? (unsaved ? <UnsavedMark label={tdoc('dirty')} /> : null)}
      {actions || children ? (
        <span className="flex shrink-0 items-center gap-1">
          {actions}
          {children}
        </span>
      ) : null}
    </div>
  );
}
