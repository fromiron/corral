import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

/** Announce observed transitions, never the completed run merely opened from history. */
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
  const ts = useTranslations('Status');
  const previous = useRef<{ runId: string; status: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (previous.current?.runId !== runId) {
      previous.current = { runId, status: ready ? status : null };
      setAnnouncement('');
      return;
    }
    if (!ready || !status) return;
    const before = previous.current.status;
    previous.current = { runId, status };
    if (before && before !== status)
      setAnnouncement(t('runStatusAnnouncement', { status: ts(status) }));
  }, [runId, status, ready, t, ts]);
  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {announcement}
    </p>
  );
}
