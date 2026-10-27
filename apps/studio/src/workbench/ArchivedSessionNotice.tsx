import type { WorkSession } from '@corral/core';
import { Banner, BannerActions, BannerTitle, Button } from '@corral/react/design-kit';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { projectsChanged } from '../projects.ts';
import { useServices } from '../services.tsx';

export function ArchivedSessionNotice({ session }: { session: WorkSession }) {
  const t = useTranslations('Sessions');
  const { repository } = useServices();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!session.archivedAt) return null;
  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await repository.updateSession(session.sessionId, {
        archived: false,
        expectedRevision: session.revision,
      });
      if (!result.ok) return setError(result.message);
      projectsChanged();
      await router.invalidate();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner status="info" size="compact" className="shrink-0">
      <BannerTitle>{t('archived')}</BannerTitle>
      <p>{t('archivedSending')}</p>
      <BannerActions>
        <Button variant="tertiary" size="compact" disabled={busy} onClick={() => void restore()}>
          {t('restoreSession')}
        </Button>
      </BannerActions>
      {error ? <p role="alert">{error}</p> : null}
    </Banner>
  );
}
