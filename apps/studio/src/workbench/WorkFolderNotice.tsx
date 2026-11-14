import { Button, cn, focusRing, Tooltip } from '@corral/react/design-kit';
import { BookOpen, FolderOpen, Pencil } from '@corral/react/icons';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

/** What the composer can say about this session's files. A failed lookup stays unknown. */
export type FolderAccess = 'unknown' | 'unlinked' | 'untrusted' | 'missing' | 'direct' | 'copy';

export function useFolderAccess(
  sessionId: string,
  projectId: string,
  revision: string,
): FolderAccess {
  const { workspaces, mode, workspaceId } = useServices();
  const [access, setAccess] = useState<FolderAccess>('unknown');
  useEffect(() => {
    void revision;
    void workspaceId;
    let current = true;
    let request = 0;
    setAccess('unknown');
    if (mode !== 'server' || !workspaces) return;
    const refresh = async () => {
      const version = ++request;
      try {
        const [binding, copy] = await Promise.all([
          workspaces.binding(projectId),
          workspaces.worktree(sessionId),
        ]);
        if (!current || request !== version) return;
        const usable = Boolean(copy && !copy.missing && !copy.removedAt);
        if (usable) setAccess('copy');
        else if (!binding) setAccess('unlinked');
        else if (binding.missing) setAccess('missing');
        else if (!binding.trusted) setAccess('untrusted');
        else setAccess('direct');
      } catch {
        if (current && request === version) setAccess('unknown');
      }
    };
    void refresh();
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    return () => {
      current = false;
      window.removeEventListener(WORKSPACE_CHANGED, refresh);
    };
  }, [workspaces, mode, workspaceId, sessionId, projectId, revision]);
  return access;
}

/**
 * One composer mark: whether the agent can read and change files, and the one next step. Every
 * state is one icon of one size in one place (workbench.md); its sentence is the icon's name and
 * tooltip, so the tool line never cuts it.
 */
export function FolderAccessNotice({
  access,
  onAction,
}: {
  access: FolderAccess;
  onAction?: () => void;
}) {
  const t = useTranslations('Sessions');
  if (access === 'unknown') return null;
  // A usable folder has no next step: a mark, not a button, still reached by keyboard so its
  // tooltip can be read. The working copy can be changed; the folder itself is only read.
  if (access === 'copy' || access === 'direct') {
    const sentence = t(access === 'copy' ? 'agentCopy' : 'agentDirect');
    // Not the eye: the Advisor control beside it on the tool line already is one.
    const Glyph = access === 'copy' ? Pencil : BookOpen;
    return (
      <Tooltip content={sentence}>
        <span
          data-testid="folder-access"
          data-access={access}
          role="img"
          aria-label={sentence}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip's trigger must be reachable by keyboard.
          tabIndex={0}
          className={cn(
            'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground [&_svg]:size-3.5',
            focusRing,
          )}
        >
          <Glyph aria-hidden="true" />
        </span>
      </Tooltip>
    );
  }
  // No usable folder: the folder icon alone, its sentence and next step its name and tooltip.
  const fact = access === 'missing' ? 'agentFolderMissing' : 'agentNoFiles';
  const next =
    access === 'untrusted' ? 'trustFolder' : access === 'missing' ? 'checkFolder' : 'linkFolder';
  // The fact is a sentence with its own full stop; the next step becomes one.
  const name = `${t(fact)} ${t(next)}.`;
  return (
    <Tooltip content={name}>
      <Button
        data-testid="working-copy-chip"
        variant="ghost"
        size="icon-compact"
        aria-label={name}
        onClick={onAction}
        className="shrink-0"
      >
        <FolderOpen aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}
