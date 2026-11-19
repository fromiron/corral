import type { RoleRunOverrides } from '@corral/contracts';
import { type HarnessOverrides, type StartFrom, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { Button, fontWeights, Select } from '../design-kit/index.ts';
import { compileDraft, type DraftCompilation } from '../editor/model.ts';
import type { SavedRevision } from '../run/session.ts';

/**
 * Starts a run of the current draft, or says why it cannot run. With `beforeStart` the run
 * starts from the revision it returns (the local server runs saved revisions only); null means
 * the draft could not be saved and nothing starts.
 */
export function RunControls({
  onStarted,
  beforeStart,
  validation,
  onShowProblems,
  onOpenConversation,
  liveAvailable = false,
  startFrom = null,
  onClearStartFrom,
  harnessOverrides,
  roleOverrides,
  breakpoints,
  mode: chosenMode,
  onModeChange,
  startDisabled = false,
}: {
  onStarted?: (runId: string) => void;
  beforeStart?: () => Promise<SavedRevision | null>;
  /** null while a required pinned revision cannot yet be checked. */
  validation?: DraftCompilation | null;
  onShowProblems?: (() => void) | undefined;
  onOpenConversation?: (() => Promise<void>) | undefined;
  /** The runtime can call real models; the person chooses per run (default: simulated). */
  liveAvailable?: boolean;
  /** The earlier version the next run starts from, with a label for it. */
  startFrom?: (StartFrom & { label: string }) | null;
  onClearStartFrom?: () => void;
  harnessOverrides?: HarnessOverrides;
  roleOverrides?: RoleRunOverrides;
  /** Steps the run pauses before. */
  breakpoints?: readonly string[];
  mode?: 'mock' | 'live';
  onModeChange?: (mode: 'mock' | 'live') => void;
  /** A shared save may still be pending after a settings detour. */
  startDisabled?: boolean;
}) {
  const t = useTranslations('Run');
  const codeText = useTranslations('Validation.codes');
  const { editor, session } = useStudioStores();
  const draft = useStore(editor, (s) => s.draft);
  const projection = useStore(session, (s) => s.projection);
  const [starting, setStarting] = useState(false);
  const [localMode, setLocalMode] = useState<'mock' | 'live'>('mock');
  const mode = chosenMode ?? localMode;
  const setMode = onModeChange ?? setLocalMode;
  const unavailable = mode === 'live' && !liveAvailable;
  const compiled = useMemo(
    () => (validation === undefined ? compileDraft(draft) : validation),
    [draft, validation],
  );
  const execution = compiled?.executionDefinition;
  const startingRef = useRef(false);
  // A test run has no session, and check steps run only in a session's working copy.
  const needsSession =
    execution?.nodes.some((n) => n.type === 'decision' && n.mode === 'check') ?? false;
  const running = projection !== null && !TERMINAL_RUN_STATUSES.has(projection.status);

  const start = async () => {
    if (
      !compiled?.definition ||
      !execution ||
      running ||
      startingRef.current ||
      needsSession ||
      unavailable ||
      startDisabled
    )
      return;
    startingRef.current = true;
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
          breakpoints,
        );
      const runId = session.getState().runId;
      if (runId) onStarted?.(runId);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="run-heading"
          className="text-subtitle"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {t('heading')}
        </h2>
        <Button
          type="button"
          onClick={start}
          disabled={
            !compiled?.runnable ||
            needsSession ||
            running ||
            starting ||
            unavailable ||
            startDisabled
          }
          variant="primary"
        >
          {starting ? t('starting') : t('start')}
        </Button>
      </div>
      {/* What a test run creates, before it starts (#77 GA-03). */}
      <p data-testid="run-scope" className="text-caption text-muted-foreground">
        {t(beforeStart ? 'scopeSaved' : 'scopeDraft')}
      </p>
      {startFrom ? (
        <div
          data-testid="start-from"
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-primary/50 bg-primary/10 px-2 py-1 text-caption"
        >
          <span>{t('startFrom', { label: startFrom.label, runId: startFrom.runId })}</span>
          <Button type="button" onClick={onClearStartFrom} variant="ghost">
            {t('clearStartFrom')}
          </Button>
        </div>
      ) : null}
      {liveAvailable || mode === 'live' ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-caption">
          <span className="text-muted-foreground">{t('agents')}</span>
          <Select
            label={t('agents')}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'mock', label: t('modeMock') },
              { value: 'live', label: t('modeLive') },
            ]}
          />
        </div>
      ) : null}
      {compiled?.diagnostics.some((issue) => issue.code === 'SPAWNS_CAPPED') ? (
        <p className="text-caption text-muted-foreground">{codeText('SPAWNS_CAPPED')}</p>
      ) : null}
      {unavailable ? (
        <p role="alert" className="text-caption text-muted-foreground">
          {t('liveUnavailable')}
        </p>
      ) : null}
      {compiled && !compiled.runnable ? (
        <p className="text-caption text-muted-foreground">
          {compiled.definition
            ? compiled.runtimeLimits.map((issue) => issue.message).join(' ') || t('notRunnableHere')
            : t('notRunnable')}
          {onShowProblems && !compiled.definition ? (
            <Button variant="ghost" size="compact" onClick={onShowProblems}>
              {t('viewProblems')}
            </Button>
          ) : null}
        </p>
      ) : needsSession ? (
        <div className="grid justify-items-start gap-1 text-caption text-muted-foreground">
          <p>{t('checksNeedSession')}</p>
          {onOpenConversation ? (
            <Button
              variant="secondary"
              size="compact"
              disabled={startDisabled}
              onClick={() => void onOpenConversation()}
            >
              {t('openTeamConversation')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
