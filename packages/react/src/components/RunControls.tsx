import type { RoleRunOverrides } from '@corral/contracts';
import { type HarnessOverrides, type StartFrom, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { Button, Select } from '../design-kit/index.ts';
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
  liveAvailable = false,
  startFrom = null,
  onClearStartFrom,
  harnessOverrides,
  roleOverrides,
  mode: chosenMode,
  onModeChange,
  startDisabled = false,
}: {
  onStarted?: (runId: string) => void;
  beforeStart?: () => Promise<SavedRevision | null>;
  /** The runtime can call real models; the person chooses per run (default: simulated). */
  liveAvailable?: boolean;
  /** The earlier version the next run starts from (CR-007), with a label for it. */
  startFrom?: (StartFrom & { label: string }) | null;
  onClearStartFrom?: () => void;
  harnessOverrides?: HarnessOverrides;
  roleOverrides?: RoleRunOverrides;
  mode?: 'mock' | 'live';
  onModeChange?: (mode: 'mock' | 'live') => void;
  /** A shared save may still be pending after a settings detour. */
  startDisabled?: boolean;
}) {
  const t = useTranslations('Run');
  const { editor, session } = useStudioStores();
  const draft = useStore(editor, (s) => s.draft);
  const projection = useStore(session, (s) => s.projection);
  const [starting, setStarting] = useState(false);
  const [localMode, setLocalMode] = useState<'mock' | 'live'>('mock');
  const mode = chosenMode ?? localMode;
  const setMode = onModeChange ?? setLocalMode;
  const unavailable = mode === 'live' && !liveAvailable;
  const compiled = useMemo(() => compileDraft(draft), [draft]);
  const running = projection !== null && !TERMINAL_RUN_STATUSES.has(projection.status);

  const start = async () => {
    if (!compiled.definition || !compiled.runnable || unavailable || startDisabled) return;
    setStarting(true);
    try {
      const saved = beforeStart ? await beforeStart() : undefined;
      if (saved === null) return;
      await session
        .getState()
        .start(
          compiled.definition,
          saved,
          mode,
          startFrom
            ? { runId: startFrom.runId, artifactVersionId: startFrom.artifactVersionId }
            : undefined,
          harnessOverrides,
          roleOverrides,
        );
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
        <Button
          type="button"
          onClick={start}
          disabled={!compiled.runnable || running || starting || unavailable || startDisabled}
          variant="primary"
          size="compact"
        >
          {starting ? t('starting') : t('start')}
        </Button>
      </div>
      {/* What a test run creates, before it starts (#77 GA-03). */}
      <p data-testid="run-scope" className="text-xs text-muted-foreground">
        {t(beforeStart ? 'scopeSaved' : 'scopeDraft')}
      </p>
      {startFrom ? (
        <div
          data-testid="start-from"
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-primary/50 bg-primary/10 px-2 py-1 text-xs"
        >
          <span>{t('startFrom', { label: startFrom.label, runId: startFrom.runId })}</span>
          <Button type="button" onClick={onClearStartFrom} variant="ghost" size="compact">
            {t('clearStartFrom')}
          </Button>
        </div>
      ) : null}
      {liveAvailable || mode === 'live' ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('agents')}</span>
          <Select
            label={t('agents')}
            value={mode}
            onValueChange={setMode}
            size="xs"
            options={[
              { value: 'mock', label: t('modeMock') },
              { value: 'live', label: t('modeLive') },
            ]}
          />
        </div>
      ) : null}
      {unavailable ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {t('liveUnavailable')}
        </p>
      ) : null}
      {!compiled.runnable ? (
        <p className="text-xs text-muted-foreground">
          {compiled.definition ? t('notRunnableHere') : t('notRunnable')}
        </p>
      ) : null}
    </div>
  );
}
