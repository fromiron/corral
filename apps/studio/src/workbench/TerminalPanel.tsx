import { RefreshCw } from '@corral/react/icons';
import { Button, Select } from '@corral/react/ui';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useRemembered } from '../pages/Workbench.tsx';
import { useServices } from '../services.tsx';
import { panelKey } from './panels/registry.ts';
import { type TerminalStore, terminalStore } from './terminals/store.ts';

const TerminalView = lazy(() =>
  import('./terminals/TerminalView.tsx').then((module) => ({ default: module.TerminalView })),
);

export function TerminalPanel({ sessionId, projectId }: { sessionId: string; projectId?: string }) {
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
      />
    );
  }
  return <SessionTerminals key={sessionId} sessionId={sessionId} store={store} />;
}

function RememberedTerminals({
  sessionId,
  store,
  selectionKey,
}: {
  sessionId: string;
  store: TerminalStore;
  selectionKey: string;
}) {
  const selection = useRemembered(selectionKey, '');
  return <SessionTerminals sessionId={sessionId} store={store} selection={selection} />;
}

function SessionTerminals({
  sessionId,
  store,
  selection,
}: {
  sessionId: string;
  store: TerminalStore;
  selection?: [string, (value: string) => void];
}) {
  const t = useTranslations('Terminals');
  const session = useStore(store, (state) => state.sessions[sessionId]);
  const list = session?.list;
  const memorySelection = useState('');
  const [selected, select] = selection ?? memorySelection;
  const [shell, setShell] = useState('');
  const [actionError, setActionError] = useState(false);
  const hintId = useId();
  const refreshButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void store.refresh(sessionId).catch(() => setActionError(true));
  }, [store, sessionId]);
  const items = list?.terminals ?? [];
  const selectedId = items.some((item) => item.terminalId === selected)
    ? selected
    : (items.find((item) => item.state === 'running')?.terminalId ?? items[0]?.terminalId ?? '');
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
            inputOverflow: value.inputOverflow,
            error: value.error,
            busy: value.busy,
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
          size="icon-sm"
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
          size="sm"
          disabled={
            Boolean(pending) ||
            hasWriter ||
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
      <p className="text-xs text-muted">{t('scopeHint')}</p>
      {hasWriter ? <p className="text-xs text-muted">{t('writerHint')}</p> : null}
      {!list?.available && !session?.loading ? (
        <p className="text-xs text-muted">{list?.reason || t('unavailable')}</p>
      ) : null}
      {pending ? (
        <div className="space-y-2">
          <p role="status" className="text-xs">
            {t('createPending')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={session?.loading}
              onClick={() => run(() => store.checkCreate(sessionId))}
            >
              {t('checkCreate')}
            </Button>
            {session?.canRetryCreate ? (
              <Button
                size="sm"
                variant="outline"
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
            hint: t(`state.${item.state}`),
          }))}
        />
      ) : !session?.loading ? (
        <p className="text-xs text-muted">{t('empty')}</p>
      ) : null}
      {entry && current ? (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" role="status">
            <span>{t(`state.${current.state}`)}</span>
            <span>{t(`connection.${entry.connection}`)}</span>
            {current.exitCode !== null ? (
              <span>{t('exitCode', { code: current.exitCode })}</span>
            ) : null}
          </div>
          {!current.replayAvailable ? (
            <p role="status" className="text-xs">
              {t('replayUnavailable')}
            </p>
          ) : null}
          {current.state === 'uncertain' ? (
            <p role="alert" className="text-xs text-danger">
              {t('uncertain')}
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
              <p className="text-xs text-muted">{t('inputRecoveryHint')}</p>
              {current.controller ? (
                <p role="status" className="text-xs text-muted">
                  {t('acceptedInput', { sequence: current.controller.acceptedSequence })}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={entry.busy}
                  onClick={() => run(() => store.checkInput(selectedId))}
                >
                  {t('checkInput')}
                </Button>
                {mayControl ? (
                  <Button
                    size="sm"
                    variant="outline"
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
            <p className="text-xs text-muted">
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
                  size="sm"
                  variant="outline"
                  disabled={entry.busy}
                  onClick={() => run(() => store.release(selectedId))}
                >
                  {t('release')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={entry.busy}
                  onClick={() => run(() => store.claim(selectedId, Boolean(current.controller)))}
                >
                  {t(current.controller ? 'takeover' : 'claim')}
                </Button>
              )
            ) : null}
            {entry.connection === 'disconnected' || entry.connection === 'idle' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={entry.busy}
                onClick={() => run(() => store.reconnect(selectedId))}
              >
                {t('reconnect')}
              </Button>
            ) : null}
            {mayStop ? (
              <Button
                size="sm"
                variant="outline"
                disabled={entry.busy || current.state === 'stopping'}
                onClick={() => run(() => store.stop(selectedId))}
              >
                {t(current.state === 'stopping' ? 'stopping' : 'stop')}
              </Button>
            ) : null}
          </div>
          {entry.connection !== 'unavailable' ? (
            <Suspense
              fallback={
                <p role="status" className="text-xs text-muted">
                  {t('loading')}
                </p>
              }
            >
              <TerminalView
                key={panelKey(store, { kind: 'terminal', sessionId, terminalId: selectedId })}
                store={store}
                terminalId={selectedId}
                ariaLabel={t('content')}
                aria-describedby={hintId}
                onExit={() => refreshButton.current?.focus()}
                className="h-64 min-w-0 overflow-hidden rounded bg-background"
              />
            </Suspense>
          ) : null}
          <p id={hintId} className="text-xs text-muted">
            {t('keyboardHint')}
          </p>
          {entry.error || current.error ? (
            <p role="alert" className="break-words text-xs text-danger">
              {entry.error || current.error}
            </p>
          ) : null}
        </>
      ) : null}
      {actionError || session?.error ? (
        <p role="alert" className="break-words text-xs text-danger">
          {session?.error || t('actionFailed')}
        </p>
      ) : null}
    </section>
  );
}
