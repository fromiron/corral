import { statusPresence } from '@corral/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

/**
 * Announce observed transitions, never the completed run merely opened from history. A change is
 * one of the run's presence (docs/specs/features/presence.md), said in its words: a status that
 * moves without changing what every screen shows is not announced.
 */
export function RunStatusAnnouncement({
  runId,
  status,
  ready,
}: {
  runId: string;
  status: string | null;
  ready: boolean;
}) {
  const t = useTranslations('Widgets');
  const tp = useTranslations('Presence');
  const labelKey = (status && statusPresence(status)?.labelKey) || null;
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
