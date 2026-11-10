import { Button, Tooltip } from '@corral/react/design-kit';
import { FolderOpen } from '@corral/react/icons';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

/**
 * Whether this server conversation has no usable working copy: none yet, or one that is missing
 * or removed. A lookup that fails is not read as "none"; it reports nothing until one succeeds.
 */
export function useWorkingCopyMissing(sessionId: string, revision: string): boolean {
  const { workspaces, mode, workspaceId } = useServices();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void revision;
    void workspaceId;
    let current = true;
    let request = 0;
    setMissing(false);
    if (mode !== 'server' || !workspaces) return;
    const refresh = async () => {
      const version = ++request;
      try {
        const copy = await workspaces.worktree(sessionId);
        if (current && request === version)
          setMissing(!copy || Boolean(copy.missing || copy.removedAt));
      } catch {
        if (current && request === version) setMissing(false);
      }
    };
    void refresh();
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    return () => {
      current = false;
      window.removeEventListener(WORKSPACE_CHANGED, refresh);
    };
  }, [workspaces, mode, workspaceId, sessionId, revision]);
  return missing;
}

/** The composer row's one mark that files cannot change here; it opens file-work setup. */
export function WorkingCopyChip({ onSetup }: { onSetup(): void }) {
  const t = useTranslations('Sessions');
  return (
    <Tooltip content={t('prepareWorkingCopy')}>
      <Button
        data-testid="working-copy-chip"
        variant="ghost"
        size="compact"
        aria-label={`${t('noWorkingCopy')} · ${t('prepareWorkingCopy')}`}
        onClick={onSetup}
      >
        <FolderOpen aria-hidden="true" />
        {t('noWorkingCopy')}
      </Button>
    </Tooltip>
  );
}
