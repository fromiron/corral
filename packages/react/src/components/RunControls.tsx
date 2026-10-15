import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { compileDraft } from '../editor/model.ts';
import type { SavedRevision } from '../run/session.ts';

/**
 * Starts a run of the current draft, or says why it cannot run. With `beforeStart` the run
 * starts from the revision it returns (the local server runs saved revisions only); null means
 * the draft could not be saved and nothing starts.
 */
export function RunControls({
  onStarted,
  beforeStart,
}: {
  onStarted?: (runId: string) => void;
  beforeStart?: () => Promise<SavedRevision | null>;
}) {
  const t = useTranslations('Run');
  const { editor, session } = useStudioStores();
  const draft = useStore(editor, (s) => s.draft);
  const projection = useStore(session, (s) => s.projection);
  const [starting, setStarting] = useState(false);
  const compiled = useMemo(() => compileDraft(draft), [draft]);
  const running = projection !== null && !TERMINAL_RUN_STATUSES.has(projection.status);

  const start = async () => {
    if (!compiled.definition || !compiled.runnable) return;
    setStarting(true);
    try {
      const saved = beforeStart ? await beforeStart() : undefined;
      if (saved === null) return;
      await session.getState().start(compiled.definition, saved);
      const runId = session.getState().runId;
      if (runId) onStarted?.(runId);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h2 id="run-heading" className="text-sm font-semibold">
          {t('heading')}
        </h2>
        <button
          type="button"
          onClick={start}
          disabled={!compiled.runnable || running || starting}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
        >
          {starting ? t('starting') : t('start')}
        </button>
      </div>
      {!compiled.runnable ? (
        <p className="text-xs text-muted">
          {compiled.definition ? t('notRunnableHere') : t('notRunnable')}
        </p>
      ) : null}
    </div>
  );
}
