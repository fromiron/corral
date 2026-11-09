import type { GitStatus, WorkspaceTarget } from '@corral/contracts';
import { GitBranch } from '@corral/react/icons';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

// Every open document's tab reads the branch at once; one Git status read answers them all.
const reads = new Map<string, Promise<GitStatus>>();

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

/**
 * A document's head: its path, where it opened from (the session working copy or the project
 * source folder), the copy's branch and whether it has unsaved changes. Actions go after it.
 */
export function DocumentHeader({
  path,
  target,
  unsaved = false,
  children,
}: {
  path: string;
  target: { kind: 'source' } | { kind: 'copy'; target: WorkspaceTarget };
  unsaved?: boolean;
  children?: ReactNode;
}) {
  const td = useTranslations('Desktop');
  const tf = useTranslations('Files');
  const tdoc = useTranslations('Documents');
  const branch = useCopyBranch(target.kind === 'copy' ? target.target : null);
  return (
    <div
      data-testid="document-header"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption"
    >
      <p className="min-w-0 flex-1 break-all text-foreground" title={path}>
        {path}
      </p>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span>{td(target.kind === 'copy' ? 'sessionCopy' : 'sourceFolder')}</span>
        {branch ? (
          <span className="inline-flex min-w-0 items-center gap-1" title={tf('branch', { branch })}>
            <GitBranch size={12} aria-hidden className="shrink-0" />
            <span className="sr-only">{tf('branch', { branch })}</span>
            <span aria-hidden className="truncate">
              {branch}
            </span>
          </span>
        ) : null}
        {unsaved ? (
          <span className="inline-flex items-center gap-1 text-foreground">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emphasis" />
            {tdoc('dirty')}
          </span>
        ) : null}
      </span>
      {children}
    </div>
  );
}
