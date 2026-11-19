import { canReadArtifactBody } from '@corral/core';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button } from '../design-kit/index.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { RunSessionStore } from '../run/session.ts';

/** A review stays attached to the version requested, even after that body retires. */
export function ReviewVersion({
  session,
  versionId,
  onOpen,
}: {
  session: RunSessionStore;
  versionId: string;
  onOpen?: ((id: string) => void) | undefined;
}) {
  const t = useTranslations('Questions');
  const r = useTranslations('Results');
  const artifact = useRunDisplay(session, (s) => s.projection?.artifacts[versionId]);
  const readable = useStore(session, (s) => canReadArtifactBody(s.projection, versionId));
  const label = t('reviewRequested', {
    version: artifact
      ? r('itemName', { name: artifact.name, version: artifact.version })
      : versionId,
  });
  return (
    <div className="flex flex-wrap items-center gap-1 text-caption">
      {artifact && readable && onOpen ? (
        <Button size="compact" variant="tertiary" onClick={() => onOpen(versionId)}>
          {label}
        </Button>
      ) : (
        <span>{label}</span>
      )}
      {(!artifact || !readable) && (
        <span className="text-muted-foreground">{t('reviewUnavailable')}</span>
      )}
    </div>
  );
}
