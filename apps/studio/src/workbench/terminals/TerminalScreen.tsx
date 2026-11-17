// A terminal tab's screen, in the panel or the bottom dock (workbench.md 사용자 터미널,
// features/session-panel.md 터미널 탭): one terminal and no head row. The tab says its state and
// closing the tab ends it; input control, attaching a selection, refreshing and the move to the
// other strip are in the ⋯ menu, which comes before the screen. Only what is happening now stands
// above the screen: a save it blocks, a lost connection, an end and its exit code, and the
// recovery a terminal in trouble needs.
import type { TextAttachment } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import {
  Banner,
  BannerTitle,
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Tooltip,
} from '@corral/react/design-kit';
import { Ellipsis } from '@corral/react/icons';
import { lazy, Suspense, useId, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { type AttachmentCapture, beginAttachmentCapture } from '../context/bridge.ts';
import type { DocumentStore } from '../documents/store.ts';
import { panelKey } from '../panels/registry.ts';
import type { TerminalProvenance, TerminalSourceState, TerminalStore } from './store.ts';

const noSubscription = () => () => {};
const TerminalView = lazy(() =>
  import('./TerminalView.tsx').then((module) => ({ default: module.TerminalView })),
);

export interface TerminalScreenProps {
  store: TerminalStore;
  sessionId: string;
  terminalId: string;
  documents?: DocumentStore | undefined;
  /** The ⋯ menu's move: to the strip the tab is not in. */
  move: { to: 'panel' | 'dock'; onMove: () => void } | null;
  /** Shift+Escape in the terminal: the focus goes to this terminal's tab in its strip. */
  onExitToTab: () => void;
  onAttach?:
    | ((attachment: TextAttachment, capture: AttachmentCapture) => void | Promise<void>)
    | undefined;
  revealSource?: TerminalProvenance | undefined;
}

export function TerminalScreen({
  store,
  sessionId,
  terminalId,
  documents,
  move,
  onExitToTab,
  onAttach,
  revealSource,
}: TerminalScreenProps) {
  const t = useTranslations('Terminals');
  const hintId = useId();
  const [actionError, setActionError] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<'selectOutput' | 'attachSelectionError' | null>(
    null,
  );
  const [sourceState, setSourceState] = useState<TerminalSourceState | null>(null);
  const entry = useStore(
    store,
    useShallow((state) => {
      const value = state.terminals[terminalId];
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
  const loading = useStore(store, (state) => Boolean(state.sessions[sessionId]?.loading));
  // A save of this session's copy refused while the terminal holds it: the block is happening now.
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
  const run = (work: () => Promise<unknown>) => {
    setActionError(false);
    void work().catch(() => setActionError(true));
  };
  const current = entry?.terminal;
  const live = current ? !['exited', 'failed'].includes(current.state) : false;
  const mayControl = current?.state === 'running' && entry?.connection !== 'unavailable';
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
  const ended =
    current && !live
      ? current.state === 'exited' && current.stopped
        ? t('stopped')
        : current.exitCode !== null
          ? `${t(`state.${current.state}`)} · ${t('exitCode', { code: current.exitCode })}`
          : t(`state.${current.state}`)
      : null;
  const inputRow =
    entry && current && mayControl && !entry.inputUnknown ? (
      <MenuItem
        disabled={entry.busy}
        onClick={() =>
          run(() =>
            entry.controlling
              ? store.release(terminalId)
              : store.claim(terminalId, Boolean(current.controller)),
          )
        }
      >
        {t(entry.controlling ? 'release' : current.controller ? 'takeover' : 'claim')}
      </MenuItem>
    ) : null;
  return (
    <section
      aria-label={t('title')}
      data-terminal-tab-screen=""
      className="relative flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="absolute top-1 right-1 z-10">
        <Menu>
          <Tooltip content={t('actions')}>
            <MenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('actions')} />}>
              <Ellipsis />
            </MenuTrigger>
          </Tooltip>
          <MenuPopup align="end" className="w-[260px]">
            {inputRow}
            {entry && current && onAttach ? (
              <MenuItem
                disabled={capturing || !entry.hasSelection}
                description={!entry.hasSelection ? t('selectOutput') : undefined}
                onClick={() => void attachSelection()}
              >
                {t(capturing ? 'capturing' : 'attachSelection')}
              </MenuItem>
            ) : null}
            <MenuItem disabled={loading} onClick={() => run(() => store.refresh(sessionId))}>
              {t('refresh')}
            </MenuItem>
            {move ? (
              <MenuItem onClick={move.onMove}>
                {t(move.to === 'panel' ? 'moveToPanel' : 'moveToDock')}
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      {/* Only what is happening now; nothing stands here otherwise. */}
      <div className="flex min-w-0 shrink-0 flex-col gap-2 px-3 py-2 pr-10 text-caption empty:hidden">
        {live && savesWaiting ? (
          <Banner data-testid="terminal-blocking" status="warning" role="status">
            <BannerTitle>{t('blockingSave')}</BannerTitle>
          </Banner>
        ) : null}
        {entry?.connection === 'disconnected' ? (
          <p data-terminal-disconnected="" role="status" className="flex items-center gap-1">
            <span>{t('disconnected')}</span>
            <span aria-hidden="true">·</span>
            <Button
              variant="link"
              disabled={entry.busy}
              onClick={() => run(() => store.reconnect(terminalId))}
            >
              {t('reconnect')}
            </Button>
          </p>
        ) : null}
        {ended ? (
          <p role="status" className="text-muted-foreground tabular-nums">
            {ended}
          </p>
        ) : null}
        {entry && current ? (
          <>
            {!current.replayAvailable ? (
              <p role="status">{t(live ? 'replayUnavailable' : 'replayUnavailableEnded')}</p>
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
                    !live
                      ? 'diagnosticEnded'
                      : current.diagnostic.code === 'host_restart_required'
                        ? 'diagnosticHostRestart'
                        : 'diagnosticCheck',
                  )}
                </p>
              </div>
            ) : current.state === 'uncertain' ? (
              <p role="alert" className="text-danger">
                {t('uncertain')}
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
                    variant="tertiary"
                    disabled={entry.busy}
                    onClick={() => run(() => store.checkInput(terminalId))}
                  >
                    {t('checkInput')}
                  </Button>
                  {mayControl ? (
                    <Button
                      variant="tertiary"
                      disabled={entry.busy}
                      onClick={() => run(() => store.claim(terminalId, true))}
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
            {sourceState === 'unavailable' ? (
              <p role="status" className="text-muted-foreground">
                {t('sourceUnavailable')}
              </p>
            ) : null}
            {(entry.error || current.error || actionError) && current.state !== 'uncertain' ? (
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
            key={panelKey(store, { kind: 'terminal', sessionId, terminalId })}
            store={store}
            terminalId={terminalId}
            revealSource={revealSource?.terminalId === terminalId ? revealSource : undefined}
            onReveal={setSourceState}
            ariaLabel={t('content')}
            aria-describedby={hintId}
            onExit={onExitToTab}
            className="h-auto min-h-0 min-w-0 flex-1 overflow-hidden bg-background px-3 py-2"
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
