import type { TextAttachment } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { StatusDot } from '@corral/react';
import {
  Banner,
  BannerTitle,
  Button,
  LiveDot,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Select,
  Tooltip,
} from '@corral/react/design-kit';
import { ChevronDown, Info, MessageSquare, Plus, RefreshCw, Square } from '@corral/react/icons';
import { lazy, Suspense, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useRemembered } from '../pages/Workbench.tsx';
import { useServices } from '../services.tsx';
import { type AttachmentCapture, beginAttachmentCapture } from './context/bridge.ts';
import type { DocumentStore } from './documents/store.ts';
import { documentStore } from './documents/store.ts';
import { panelKey } from './panels/registry.ts';
import {
  type TerminalProvenance,
  type TerminalSourceState,
  type TerminalStore,
  terminalStore,
} from './terminals/store.ts';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const noSubscription = () => () => {};
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
  const { terminals, mode, workspaceId, workspaces } = useServices();
  if (!terminals || mode !== 'server') return null;
  const store = terminalStore(terminals);
  const documents = workspaces ? documentStore(workspaces) : undefined;
  if (workspaceId && projectId) {
    const selectionKey = `corral:terminal-selection:v1:${JSON.stringify([workspaceId, projectId, sessionId])}`;
    return (
      <RememberedTerminals
        key={selectionKey}
        sessionId={sessionId}
        store={store}
        selectionKey={selectionKey}
        documents={documents}
        {...context}
      />
    );
  }
  return (
    <SessionTerminals
      key={sessionId}
      sessionId={sessionId}
      store={store}
      documents={documents}
      {...context}
    />
  );
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
  documents?: DocumentStore;
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
  documents,
}: {
  sessionId: string;
  store: TerminalStore;
  selection?: [string, (value: string) => void];
  documents?: DocumentStore;
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
  // A save of this session's copy refused while a writer holds it: the block is happening now.
  const readSavesWaiting = () =>
    Boolean(
      documents &&
        Object.values(documents.getState().documents).some(
          (document) => document.target.sessionId === sessionId && document.writerBusy,
        ),
    );
  const savesWaiting = useSyncExternalStore(
    documents?.subscribe ?? noSubscription,
    readSavesWaiting,
    readSavesWaiting,
  );
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
  const stateText = current
    ? current.state === 'exited' && current.stopped
      ? t('stopped')
      : t(`state.${current.state}`)
    : '';
  const dotColor =
    current?.state === 'failed'
      ? 'var(--destructive)'
      : current?.state === 'uncertain'
        ? 'var(--warning)'
        : current?.state === 'exited'
          ? 'var(--muted-foreground)'
          : 'var(--emphasis)';
  const shellLabel = list?.shells.find((item) => item.id === shellId)?.label;
  const createDisabled =
    Boolean(pending) ||
    hasWriter ||
    runActive ||
    Boolean(session?.loading) ||
    !list?.available ||
    !list.target ||
    !shellId;
  // Why New terminal cannot be used, in the order the checks above hold it back.
  const createHeldBy = pending
    ? 'createPending'
    : hasWriter
      ? 'createHeld'
      : runActive
        ? 'runActive'
        : session?.loading
          ? 'loading'
          : 'unavailable';
  const create = (id: string) =>
    run(async () => {
      const created = await store.create(sessionId, id);
      if (created) select(created);
    });
  const stopLabel =
    entry && current
      ? t(
          entry.busy || current.state === 'stopping'
            ? 'stopping'
            : current.state === 'uncertain' && current.diagnostic
              ? 'recheckTermination'
              : 'stop',
        )
      : '';
  return (
    <section
      aria-label={t('title')}
      data-testid="terminal-panel"
      className="@container/term flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="flex min-h-10 min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5">
        {items.length ? (
          <Select
            variant="chip"
            label={t('select')}
            value={selectedId}
            onValueChange={select}
            className="min-w-0 max-w-64"
            options={items.map((item, index) => ({
              value: item.terminalId,
              label: t('terminalName', { number: index + 1, shell: item.shellId }),
              hint:
                item.state === 'exited' && item.stopped ? t('stopped') : t(`state.${item.state}`),
            }))}
          />
        ) : !session?.loading ? (
          <span className="min-w-0 truncate text-caption text-muted-foreground">{t('empty')}</span>
        ) : null}
        {entry && current ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-caption">
            <span role="status" className="inline-flex min-w-0 items-center gap-1.5">
              <LiveDot
                color={dotColor}
                live={current.state === 'running' && entry.connection === 'connected'}
              />
              <span className="text-foreground">{stateText}</span>
              <span className="truncate text-muted-foreground @max-md/term:sr-only">
                {t(`connection.${entry.connection}`)}
              </span>
              {current.exitCode !== null && !current.stopped ? (
                <span className="text-muted-foreground tabular-nums">
                  {t('exitCode', { code: current.exitCode })}
                </span>
              ) : null}
            </span>
            <Popover>
              <Tooltip content={t('details')}>
                <PopoverTrigger
                  render={<Button variant="ghost" size="icon-compact" aria-label={t('details')} />}
                >
                  <Info />
                </PopoverTrigger>
              </Tooltip>
              {/* At most two short lines: what holds the copy and how to free it. */}
              <PopoverPopup width="md" aria-label={t('details')}>
                <div className="flex flex-col gap-1 text-caption text-muted-foreground">
                  {hasWriter ? (
                    <>
                      <p>{t('writerHint')}</p>
                      <p>{t('releaseHint')}</p>
                    </>
                  ) : (
                    <p>{t('scopeHint')}</p>
                  )}
                </div>
              </PopoverPopup>
            </Popover>
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {entry && current && mayControl && !entry.inputUnknown ? (
            entry.controlling ? (
              <Button
                size="compact"
                variant="ghost"
                disabled={entry.busy}
                onClick={() => run(() => store.release(selectedId))}
              >
                {t('release')}
              </Button>
            ) : (
              // Who holds input is read here, where it is taken.
              <Tooltip content={t(current.controller ? 'otherController' : 'readOnly')}>
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={entry.busy}
                  onClick={() => run(() => store.claim(selectedId, Boolean(current.controller)))}
                >
                  {t(current.controller ? 'takeover' : 'claim')}
                </Button>
              </Tooltip>
            )
          ) : null}
          {entry && (entry.connection === 'disconnected' || entry.connection === 'idle') ? (
            <Button
              size="compact"
              variant="tertiary"
              disabled={entry.busy}
              onClick={() => run(() => store.reconnect(selectedId))}
            >
              {t('reconnect')}
            </Button>
          ) : null}
          {entry && current && mayStop ? (
            current.state === 'uncertain' ? (
              // Recovery keeps its words: this stop also verifies termination.
              <Button
                size="compact"
                variant="tertiary"
                disabled={entry.busy}
                onClick={() => {
                  setStopAttempted(selectedId);
                  run(() => store.stop(selectedId));
                }}
              >
                {stopLabel}
              </Button>
            ) : (
              <Tooltip content={stopLabel}>
                <Button
                  size="icon-compact"
                  variant="ghost"
                  aria-label={stopLabel}
                  disabled={entry.busy || current.state === 'stopping'}
                  onClick={() => {
                    setStopAttempted(selectedId);
                    run(() => store.stop(selectedId));
                  }}
                >
                  <Square />
                </Button>
              </Tooltip>
            )
          ) : null}
          {entry && current && onAttach ? (
            <Tooltip
              content={t(
                capturing ? 'capturing' : entry.hasSelection ? 'attachSelection' : 'selectOutput',
              )}
            >
              {/* The wrapper keeps the reason reachable by pointer while the button is disabled. */}
              <span className="inline-flex">
                <Button
                  size="icon-compact"
                  variant="ghost"
                  aria-label={t(capturing ? 'capturing' : 'attachSelection')}
                  disabled={capturing || !entry.hasSelection}
                  onClick={() => void attachSelection()}
                >
                  <MessageSquare />
                </Button>
              </span>
            </Tooltip>
          ) : null}
          <Tooltip content={t('refresh')}>
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
          </Tooltip>
          <Tooltip
            content={
              createDisabled ? (
                t(createHeldBy)
              ) : (
                <span className="flex flex-col">
                  <span>{shellLabel ? `${t('create')} · ${shellLabel}` : t('create')}</span>
                  <span>{t('scopeHint')}</span>
                </span>
              )
            }
          >
            {/* The wrapper keeps the reason reachable by pointer while the button is disabled. */}
            <span className="inline-flex">
              <Button
                size="compact"
                variant={items.length || createDisabled ? 'ghost' : 'primary'}
                aria-label={t('create')}
                disabled={createDisabled}
                onClick={() => create(shellId)}
              >
                <Plus aria-hidden />
                <span className="@max-md/term:sr-only">{t('create')}</span>
              </Button>
            </span>
          </Tooltip>
          {(list?.shells.length ?? 0) > 1 ? (
            <Menu>
              <Tooltip content={t('chooseShell')}>
                <MenuTrigger
                  disabled={createDisabled}
                  render={
                    <Button variant="ghost" size="icon-compact" aria-label={t('chooseShell')} />
                  }
                >
                  <ChevronDown />
                </MenuTrigger>
              </Tooltip>
              <MenuPopup align="end" className="min-w-44">
                {(list?.shells ?? []).map((item) => (
                  <MenuItem
                    key={item.id}
                    onClick={() => {
                      setShell(item.id);
                      create(item.id);
                    }}
                  >
                    {item.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
        </span>
      </div>
      {/* Only what blocks this terminal, a save or a run right now; nothing stands here otherwise. */}
      <div className="flex min-w-0 shrink-0 flex-col gap-2 px-3 py-2 text-caption empty:hidden">
        {runActive ? (
          <p role="status" className="text-muted-foreground">
            {t('runActive')}
          </p>
        ) : null}
        {hasWriter && savesWaiting ? (
          <Banner data-testid="terminal-blocking" status="warning" size="compact" role="status">
            <BannerTitle>{t('blockingSave')}</BannerTitle>
          </Banner>
        ) : null}
        {!list?.available && !session?.loading ? (
          <div className="text-muted-foreground">
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
            <p role="status">{t('createPending')}</p>
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
        {entry && current ? (
          <>
            {!current.replayAvailable ? (
              <p role="status">
                {t(
                  current.state === 'exited' || current.state === 'failed'
                    ? 'replayUnavailableEnded'
                    : 'replayUnavailable',
                )}
              </p>
            ) : null}
            {current.diagnostic ? (
              <div
                data-testid="terminal-recovery-guidance"
                role="alert"
                className="space-y-1 text-danger"
              >
                <p>{t(`diagnosticReason.${current.diagnostic.code}`)}</p>
                <p>
                  {t(
                    !mayStop
                      ? 'diagnosticEnded'
                      : current.diagnostic.code === 'host_restart_required'
                        ? 'diagnosticHostRestart'
                        : 'diagnosticCheck',
                  )}
                </p>
              </div>
            ) : current.state === 'uncertain' ? (
              <p role="alert" className="text-danger">
                {t(
                  stopAttempted === current.terminalId && !entry.busy
                    ? 'stopUnconfirmed'
                    : 'uncertain',
                )}
              </p>
            ) : null}
            {entry.rateLimited ? (
              <p role="status" className="text-warning">
                {t('rateLimited')}
              </p>
            ) : null}
            {entry.inputOverflow ? (
              <p role="alert" className="text-danger">
                {t('inputOverflow')}
              </p>
            ) : null}
            {entry.inputUnknown ? (
              <div className="space-y-2">
                <p role="alert" className="text-danger">
                  {t('inputUnknown')}
                </p>
                <p className="text-muted-foreground">{t('inputRecoveryHint')}</p>
                {current.controller ? (
                  <p role="status" className="text-muted-foreground">
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
            {captureError ? (
              <p role="alert" className="text-danger">
                {t(captureError)}
              </p>
            ) : null}
            {sourceState === 'stale' ? (
              <p role="status" className="text-muted-foreground">
                {t('sourceStale')}
              </p>
            ) : null}
            {(entry.error || current.error) && current.state !== 'uncertain' ? (
              <p role="alert" className="text-danger">
                {t('actionFailed')}
              </p>
            ) : null}
            {entry.error || current.error || current.diagnostic ? (
              <details className="text-muted-foreground">
                <summary>{t('diagnostics')}</summary>
                {current.diagnostic ? (
                  <code>
                    {current.diagnostic.phase} · {current.diagnostic.code}
                  </code>
                ) : null}
                {entry.error || current.error ? (
                  <p className="break-words">{entry.error || current.error}</p>
                ) : null}
              </details>
            ) : null}
          </>
        ) : null}
        {sourceState === 'unavailable' ||
        sourceUnavailable ||
        (terminalId &&
          !session?.loading &&
          !items.some((item) => item.terminalId === terminalId)) ? (
          <p role="status" className="text-muted-foreground">
            {t('sourceUnavailable')}
          </p>
        ) : null}
        {actionError || session?.error ? (
          <div role="alert" className="text-danger">
            <p>
              {session?.error?.includes('working copy writer')
                ? t('writerBusy')
                : t('actionFailed')}
            </p>
            {session?.error ? (
              <details>
                <summary>{t('diagnostics')}</summary>
                <p className="break-words">{session.error}</p>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
      {entry && current && entry.connection !== 'unavailable' ? (
        <Suspense
          fallback={
            <p role="status" className="px-3 py-2 text-caption text-muted-foreground">
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
            className="h-auto min-h-40 min-w-0 flex-1 overflow-hidden bg-background px-3 py-2"
          />
        </Suspense>
      ) : null}
      {/* The terminal's keyboard escape, read with it. */}
      <p id={hintId} className="sr-only">
        {t('keyboardHint')}
      </p>
    </section>
  );
}
