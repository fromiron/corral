import type { Presence } from '@corral/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

/**
 * Announce observed transitions, never the completed run merely opened from history. A change is
 * one of the shown state (docs/specs/features/presence.md), the same presence the run row's head
 * shows, said by its name alone: a status value or a detail that moves without changing the
 * shown state is not announced.
 */
export function RunStatusAnnouncement({
  runId,
  presence,
  ready,
}: {
  runId: string;
  presence: Presence | null;
  ready: boolean;
}) {
  const t = useTranslations('Widgets');
  const tp = useTranslations('Presence');
  const labelKey = presence?.labelKey ?? null;
  const previous = useRef<{ runId: string; labelKey: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (previous.current?.runId !== runId) {
      previous.current = { runId, labelKey: ready ? labelKey : null };
      setAnnouncement('');
      return;
    }
    if (!ready || !labelKey) return;
    const before = previous.current.labelKey;
    previous.current = { runId, labelKey };
    if (before && before !== labelKey)
      setAnnouncement(t('runStatusAnnouncement', { status: tp(labelKey) }));
  }, [runId, labelKey, ready, t, tp]);
  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {announcement}
    </p>
  );
}
