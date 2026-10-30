import type { TextAttachment } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { StatusDot } from '@corral/react';
import { Button, Select } from '@corral/react/design-kit';
import { RefreshCw } from '@corral/react/icons';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useRemembered } from '../pages/Workbench.tsx';
import { useServices } from '../services.tsx';
import { type AttachmentCapture, beginAttachmentCapture } from './context/bridge.ts';
import { panelKey } from './panels/registry.ts';
import {
  type TerminalProvenance,
  type TerminalSourceState,
  type TerminalStore,
  terminalStore,
} from './terminals/store.ts';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const TerminalView = lazy(() =>
  import('./terminals/TerminalView.tsx').then((module) => ({ default: module.TerminalView })),
);

export function TerminalActivity({ sessionId }: { sessionId: string }) {
  const { terminals } = useServices();
  return terminals ? (
    <TerminalActivityState sessionId={sessionId} store={terminalStore(terminals)} />
  ) : null;
}

function TerminalActivityState({ sessionId, store }: { sessionId: string; store: TerminalStore }) {
  const t = useTranslations('Terminals');
  const activity = useStore(store, (state) => {
    const terminals = state.sessions[sessionId]?.list?.terminals;
    return terminals?.some((terminal) => terminal.state === 'uncertain')
      ? 'uncertain'
      : terminals?.some((terminal) => terminal.state === 'running')
        ? 'running'
        : null;
  });
  return activity ? (
    <StatusDot
      status={activity === 'uncertain' ? 'warning' : 'running'}
      label={t(activity === 'uncertain' ? 'uncertainTab' : 'runningTab')}
    />
  ) : null;
}

interface TerminalContextProps {
  runActive?: boolean;
  terminalId?: string;
  onAttach?: (attachment: TextAttachment, capture: AttachmentCapture) => void | Promise<void>;
  revealSource?: TerminalProvenance;
}

export function TerminalPanel({
  sessionId,
  projectId,
  ...context
}: { sessionId: string; projectId?: string } & TerminalContextProps) {
  const { terminals, mode, workspaceId } = useServices();
  if (!terminals || mode !== 'server') return null;
  const store = terminalStore(terminals);
  if (workspaceId && projectId) {
    const selectionKey = `corral:terminal-selection:v1:${JSON.stringify([workspaceId, projectId, sessionId])}`;
    return (
      <RememberedTerminals
        key={selectionKey}
        sessionId={sessionId}
        store={store}
        selectionKey={selectionKey}
        {...context}
      />
    );
  }
  return <SessionTerminals key={sessionId} sessionId={sessionId} store={store} {...context} />;
}

function RememberedTerminals({
  sessionId,
  store,
  selectionKey,
  ...context
}: {
  sessionId: string;
  store: TerminalStore;
  selectionKey: string;
} & TerminalContextProps) {
  const selection = useRemembered(selectionKey, '');
  return (
    <SessionTerminals sessionId={sessionId} store={store} selection={selection} {...context} />
  );
}

function SessionTerminals({
  sessionId,
  store,
  selection,
  onAttach,
  revealSource,
  runActive = false,
  terminalId,
}: {
  sessionId: string;
  store: TerminalStore;
  selection?: [string, (value: string) => void];
} & TerminalContextProps) {
  const t = useTranslations('Terminals');
  const session = useStore(store, (state) => state.sessions[sessionId]);
  const list = session?.list;
  const memorySelection = useState(terminalId ?? '');
  const [selected, select] = selection ?? memorySelection;
  const [shell, setShell] = useState('');
  const [actionError, setActionError] = useState(false);
  const [stopAttempted, setStopAttempted] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<'selectOutput' | 'attachSelectionError' | null>(
    null,
  );
  const [sourceState, setSourceState] = useState<TerminalSourceState | null>(null);
  useEffect(() => {
    setSourceState(null);
    if (terminalId) select(terminalId);
    else if (revealSource?.target.sessionId === sessionId) select(revealSource.terminalId);
  }, [terminalId, revealSource, sessionId, select]);
  const hintId = useId();
  const refreshButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void runActive;
    const refresh = () => void store.refresh(sessionId).catch(() => setActionError(true));
    refresh();
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    return () => window.removeEventListener(WORKSPACE_CHANGED, refresh);
  }, [store, sessionId, runActive]);
  const items = list?.terminals ?? [];
  const selectedId =
    terminalId && selected === terminalId && !items.some((item) => item.terminalId === terminalId)
      ? ''
      : items.some((item) => item.terminalId === selected)
        ? selected
        : (items.find((item) => item.state === 'running')?.terminalId ??
          items[0]?.terminalId ??
          '');
  const entry = useStore(
    store,
    useShallow((state) => {
      const value = state.terminals[selectedId];
      return value
        ? {
            terminal: value.terminal,
            connection: value.connection,
            controlling: value.controlling,
            inputUnknown: value.inputUnknown,
            rateLimited: value.rateLimited,
            inputOverflow: value.inputOverflow,
            error: value.error,
            busy: value.busy,
            hasSelection: value.hasSelection,
          }
        : undefined;
    }),
  );
  const current = entry?.terminal;
  const shellId = list?.shells.some((item) => item.id === shell)
    ? shell
    : (list?.shells[0]?.id ?? '');
  const pending = session?.pendingCreate;
  const hasWriter = items.some((item) => !['exited', 'failed'].includes(item.state));
  const run = (work: () => Promise<unknown>) => {
    setActionError(false);
    void work().catch(() => setActionError(true));
  };
  const mayStop = current && !['exited', 'failed'].includes(current.state);
  const mayControl = current?.state === 'running' && entry?.connection !== 'unavailable';
  const sourceUnavailable =
    revealSource &&
    !session?.loading &&
    (revealSource.target.sessionId !== sessionId ||
      !items.some((item) => item.terminalId === revealSource.terminalId));
  async function attachSelection() {
    if (!current || !onAttach || capturing) return;
    const capture = beginAttachmentCapture(current.target);
    setCapturing(true);
    setCaptureError(null);
    try {
      const selected = await store.captureSelection(current.terminalId);
      if (!selected) {
        setCaptureError('selectOutput');
        return;
      }
      const attachment = createTextAttachment(
        `terminal-${current.shellId}-${selected.provenance.outputSequence}.txt`,
        'text/plain',
        selected.text,
        selected.provenance,
      );
      await onAttach(attachment, capture);
    } catch {
      setCaptureError('attachSelectionError');
    } finally {
      setCapturing(false);
    }
  }
  return (
    <section
      aria-label={t('title')}
      data-testid="terminal-panel"
      className="flex min-w-0 flex-col gap-2 rounded fill-group p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('title')}</h3>
        <Button
          ref={refreshButton}
          size="icon-compact"
          variant="ghost"
          aria-label={t('refresh')}
          aria-disabled={session?.loading}
          onClick={() => {
            if (!session?.loading) run(() => store.refresh(sessionId));
          }}
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          className="h-8 sm:h-7"
          label={t('shell')}
          value={shellId || null}
          placeholder={t('shell')}
          options={(list?.shells ?? []).map((item) => ({ value: item.id, label: item.label }))}
          onValueChange={setShell}
          disabled={Boolean(pending) || !list?.available || !shellId}
        />
        <Button
          size="compact"
          disabled={
            Boolean(pending) ||
            hasWriter ||
            runActive ||
            Boolean(session?.loading) ||
            !list?.available ||
            !list.target ||
            !shellId
          }
          onClick={() =>
            run(async () => {
              const id = await store.create(sessionId, shellId);
              if (id) select(id);
            })
          }
        >
          {t('create')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('scopeHint')}</p>
      {runActive ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('runActive')}
        </p>
      ) : null}
      {hasWriter ? <p className="text-xs text-muted-foreground">{t('writerHint')}</p> : null}
      {hasWriter ? <p className="text-xs text-muted-foreground">{t('releaseHint')}</p> : null}
      {!list?.available && !session?.loading ? (
        <div className="text-xs text-muted-foreground">
          <p>{t('unavailable')}</p>
          {list?.reason ? (
            <details>
              <summary>{t('diagnostics')}</summary>
              <p>{list.reason}</p>
            </details>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <div className="space-y-2">
          <p role="status" className="text-xs">
            {t('createPending')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="compact"
              variant="tertiary"
              disabled={session?.loading}
              onClick={() => run(() => store.checkCreate(sessionId))}
            >
              {t('checkCreate')}
            </Button>
            {session?.canRetryCreate ? (
              <Button
                size="compact"
                variant="tertiary"
                disabled={session.loading}
                onClick={() => run(() => store.retryCreate(sessionId))}
              >
                {t('retryCreate')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {items.length ? (
        <Select
          label={t('select')}
          size="sm"
          className="h-8 w-full sm:h-7"
          value={selectedId}
          onValueChange={select}
          options={items.map((item, index) => ({
            value: item.terminalId,
            label: t('terminalName', { number: index + 1, shell: item.shellId }),
            hint: item.state === 'exited' && item.stopped ? t('stopped') : t(`state.${item.state}`),
          }))}
        />
      ) : !session?.loading ? (
        <p className="text-xs text-muted-foreground">{t('empty')}</p>
      ) : null}
      {entry && current ? (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" role="status">
            <span>
              {current.state === 'exited' && current.stopped
                ? t('stopped')
                : t(`state.${current.state}`)}
            </span>
            <span>{t(`connection.${entry.connection}`)}</span>
            {current.exitCode !== null && !current.stopped ? (
              <span>{t('exitCode', { code: current.exitCode })}</span>
            ) : null}
          </div>
          {!current.replayAvailable ? (
            <p role="status" className="text-xs">
              {t(
                current.state === 'exited' || current.state === 'failed'
                  ? 'replayUnavailableEnded'
                  : 'replayUnavailable',
              )}
            </p>
          ) : null}
          {current.state === 'uncertain' ? (
            <p role="alert" className="text-xs text-danger">
              {t(
                stopAttempted === current.terminalId && !entry.busy
                  ? 'stopUnconfirmed'
                  : 'uncertain',
              )}
            </p>
          ) : null}
          {entry.rateLimited ? (
            <p role="status" className="text-xs text-warning">
              {t('rateLimited')}
            </p>
          ) : null}
          {entry.inputOverflow ? (
            <p role="alert" className="text-xs text-danger">
              {t('inputOverflow')}
            </p>
          ) : null}
          {entry.inputUnknown ? (
            <div className="space-y-2">
              <p role="alert" className="text-xs text-danger">
                {t('inputUnknown')}
              </p>
              <p className="text-xs text-muted-foreground">{t('inputRecoveryHint')}</p>
              {current.controller ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {t('acceptedInput', { sequence: current.controller.acceptedSequence })}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={entry.busy}
                  onClick={() => run(() => store.checkInput(selectedId))}
                >
                  {t('checkInput')}
                </Button>
                {mayControl ? (
                  <Button
                    size="compact"
                    variant="tertiary"
                    disabled={entry.busy}
                    onClick={() => run(() => store.claim(selectedId, true))}
                  >
                    {t('restartInput')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {mayControl ? (
            <p className="text-xs text-muted-foreground">
              {t(
                entry.controlling
                  ? 'controlling'
                  : current.controller
                    ? 'otherController'
                    : 'readOnly',
              )}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {mayControl && !entry.inputUnknown ? (
              entry.controlling ? (
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={entry.busy}
                  onClick={() => run(() => store.release(selectedId))}
                >
                  {t('release')}
                </Button>
              ) : (
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={entry.busy}
                  onClick={() => run(() => store.claim(selectedId, Boolean(current.controller)))}
                >
                  {t(current.controller ? 'takeover' : 'claim')}
                </Button>
              )
            ) : null}
            {entry.connection === 'disconnected' || entry.connection === 'idle' ? (
              <Button
                size="compact"
                variant="tertiary"
                disabled={entry.busy}
                onClick={() => run(() => store.reconnect(selectedId))}
              >
                {t('reconnect')}
              </Button>
            ) : null}
            {mayStop ? (
              <Button
                size="compact"
                variant="tertiary"
                disabled={entry.busy || current.state === 'stopping'}
                onClick={() => {
                  setStopAttempted(selectedId);
                  run(() => store.stop(selectedId));
                }}
              >
                {t(entry.busy || current.state === 'stopping' ? 'stopping' : 'stop')}
              </Button>
            ) : null}
          </div>
          {onAttach ? (
            <Button
              size="compact"
              variant="tertiary"
              disabled={capturing || !entry.hasSelection}
              onClick={() => void attachSelection()}
            >
              {t(capturing ? 'capturing' : 'attachSelection')}
            </Button>
          ) : null}
          {captureError ? (
            <p role="alert" className="text-xs text-danger">
              {t(captureError)}
            </p>
          ) : null}
          {sourceState === 'stale' ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t('sourceStale')}
            </p>
          ) : null}
          {entry.connection !== 'unavailable' ? (
            <Suspense
              fallback={
                <p role="status" className="text-xs text-muted-foreground">
                  {t('loading')}
                </p>
              }
            >
              <TerminalView
                key={panelKey(store, { kind: 'terminal', sessionId, terminalId: selectedId })}
                store={store}
                terminalId={selectedId}
                revealSource={revealSource?.terminalId === selectedId ? revealSource : undefined}
                onReveal={setSourceState}
                ariaLabel={t('content')}
                aria-describedby={hintId}
                onExit={() => refreshButton.current?.focus()}
                className="h-64 min-w-0 overflow-hidden rounded bg-background"
              />
            </Suspense>
          ) : null}
          <p id={hintId} className="text-xs text-muted-foreground">
            {t('keyboardHint')}
          </p>
          {(entry.error || current.error) && current.state !== 'uncertain' ? (
            <p role="alert" className="text-xs text-danger">
              {t('actionFailed')}
            </p>
          ) : null}
          {entry.error || current.error ? (
            <details>
              <summary>{t('diagnostics')}</summary>
              <p className="break-words text-xs text-muted-foreground">
                {entry.error || current.error}
              </p>
            </details>
          ) : null}
        </>
      ) : null}
      {sourceState === 'unavailable' ||
      sourceUnavailable ||
      (terminalId && !session?.loading && !items.some((item) => item.terminalId === terminalId)) ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('sourceUnavailable')}
        </p>
      ) : null}
      {actionError || session?.error ? (
        <div role="alert" className="text-xs text-danger">
          <p>
            {session?.error?.includes('working copy writer') ? t('writerBusy') : t('actionFailed')}
          </p>
          {session?.error ? (
            <details>
              <summary>{t('diagnostics')}</summary>
              <p className="break-words">{session.error}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
