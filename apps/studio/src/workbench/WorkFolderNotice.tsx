import { Banner, BannerActions, BannerTitle, Button } from '@corral/react/design-kit';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useRemembered } from '../pages/Workbench.tsx';
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
  const { workspaces, mode, workspaceId } = useServices();
  const t = useTranslations('Sessions');
  const [missingCopy, setMissingCopy] = useState<string | null>(null);
  const [dismissedCopy, rememberDismissal] = useRemembered<string | null>(
    `corral:work-folder-notice:v1:${JSON.stringify([workspaceId ?? mode, sessionId])}`,
    null,
  );
  useEffect(() => {
    void revision;
    void workspaceId;
    let current = true;
    let request = 0;
    setMissingCopy(null);
    if (mode !== 'server' || !workspaces) return;
    const refresh = async () => {
      const version = ++request;
      try {
        const copy = await workspaces.worktree(sessionId);
        if (current && request === version)
          setMissingCopy(
            !copy
              ? 'none'
              : copy.missing || copy.removedAt
                ? JSON.stringify([copy.bindingId, copy.copyGeneration])
                : null,
          );
      } catch {
        if (current && request === version) setMissingCopy(null);
      }
    };
    void refresh();
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    return () => {
      current = false;
      window.removeEventListener(WORKSPACE_CHANGED, refresh);
    };
  }, [workspaces, mode, workspaceId, sessionId, revision]);
  if (!missingCopy) return null;
  const dismissed = dismissedCopy === missingCopy;
  return (
    <>
      <Banner
        data-testid="work-folder-notice"
        status="info"
        size="compact"
        open={!dismissed}
        dismissible
        dismissLabel={t('hideWorkingCopyNotice')}
        onDismiss={() => rememberDismissal(missingCopy)}
      >
        <BannerTitle>{t('noWorkingCopy')}</BannerTitle>
        <BannerActions>
          <Button size="compact" variant="tertiary" onClick={onSetup}>
            {t('prepareWorkingCopy')}
          </Button>
        </BannerActions>
      </Banner>
      {dismissed ? (
        <Button
          data-testid="work-folder-setup"
          size="compact"
          variant="ghost"
          className="self-start"
          onClick={onSetup}
        >
          {t('prepareWorkingCopy')}
        </Button>
      ) : null}
    </>
  );
}
