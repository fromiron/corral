import { Banner, BannerActions, BannerTitle, Button } from '@corral/react/design-kit';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

export function WorkFolderNotice({
  sessionId,
  revision,
  onSetup,
}: {
  sessionId: string;
  revision: string;
  onSetup(): void;
}) {
  const { workspaces, mode } = useServices();
  const t = useTranslations('Sessions');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void revision;
    let current = true;
    let request = 0;
    setMissing(false);
    if (mode !== 'server' || !workspaces) return;
    const refresh = async () => {
      const version = ++request;
      try {
        const copy = await workspaces.worktree(sessionId);
        if (current && request === version)
          setMissing(!copy || copy.missing || Boolean(copy.removedAt));
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
  }, [workspaces, mode, sessionId, revision]);
  if (!missing) return null;
  return (
    <Banner data-testid="work-folder-notice" status="info" size="compact">
      <BannerTitle>{t('noWorkingCopy')}</BannerTitle>
      <BannerActions>
        <Button size="compact" variant="tertiary" onClick={onSetup}>
          {t('prepareWorkingCopy')}
        </Button>
      </BannerActions>
    </Banner>
  );
}
