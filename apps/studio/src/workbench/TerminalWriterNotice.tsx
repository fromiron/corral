import { Banner, BannerActions, BannerTitle, Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { createContext, useContext, useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { type TerminalStore, terminalStore } from './terminals/store.ts';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

/**
 * The session page's way to a terminal: its tab wherever it is (the panel, opened by the usual
 * rules, or the bottom dock), the focus in its input. A link to the address already shown opens
 * nothing, so without this the notice could not bring a panel tab forward.
 */
export const OpenTerminalContext = createContext<((terminalId: string) => void) | null>(null);

/**
 * An observed owner is guidance; the server still decides whether a request may start. A host
 * that shares the Paddock takes a request beside a running terminal (workbench.md 공유 개발 모드),
 * so there only a terminal whose end is unconfirmed is told.
 */
export function TerminalWriterNotice({ sessionId }: { sessionId: string }) {
  const { terminals, mode, sharedDevelopment = false } = useServices();
  return terminals && mode === 'server' ? (
    <WriterNotice
      sessionId={sessionId}
      store={terminalStore(terminals)}
      shared={sharedDevelopment}
    />
  ) : null;
}

function WriterNotice({
  sessionId,
  store,
  shared,
}: {
  sessionId: string;
  store: TerminalStore;
  shared: boolean;
}) {
  const t = useTranslations('Terminals');
  const openTerminal = useContext(OpenTerminalContext);
  const terminal = useStore(store, (state) => {
    const terminals = state.sessions[sessionId]?.list?.terminals;
    return (
      terminals?.find((item) => item.state === 'uncertain') ??
      (shared ? undefined : terminals?.find((item) => !['exited', 'failed'].includes(item.state)))
    );
  });
  useEffect(() => {
    const refresh = () => {
      if (!store.getState().sessions[sessionId]?.loading) void store.refresh(sessionId);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    window.addEventListener(WORKSPACE_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED, refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [sessionId, store]);
  if (!terminal) return null;
  return (
    <Banner data-testid="terminal-writer-notice" status="warning" role="status">
      <BannerTitle>
        {t(terminal.state === 'uncertain' ? 'writerUncertainNotice' : 'writerNotice')}
      </BannerTitle>
      <BannerActions>
        <Button
          variant="secondary"
          render={
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId }}
              search={{ panel: 'terminal', terminal: terminal.terminalId }}
              onClick={(event) => {
                if (!openTerminal || event.defaultPrevented || event.button !== 0) return;
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                openTerminal(terminal.terminalId);
              }}
            />
          }
        >
          {t('openControls')}
        </Button>
      </BannerActions>
    </Banner>
  );
}
