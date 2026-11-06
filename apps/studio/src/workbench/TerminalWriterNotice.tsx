import { Banner, BannerActions, BannerTitle, Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { type TerminalStore, terminalStore } from './terminals/store.ts';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

/** An observed owner is guidance; the server still decides whether a request may start. */
export function TerminalWriterNotice({ sessionId }: { sessionId: string }) {
  const { terminals, mode } = useServices();
  return terminals && mode === 'server' ? (
    <WriterNotice sessionId={sessionId} store={terminalStore(terminals)} />
  ) : null;
}

function WriterNotice({ sessionId, store }: { sessionId: string; store: TerminalStore }) {
  const t = useTranslations('Terminals');
  const terminal = useStore(store, (state) => {
    const terminals = state.sessions[sessionId]?.list?.terminals;
    return (
      terminals?.find((item) => item.state === 'uncertain') ??
      terminals?.find((item) => !['exited', 'failed'].includes(item.state))
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
    <Banner data-testid="terminal-writer-notice" status="warning" size="compact" role="status">
      <BannerTitle>
        {t(terminal.state === 'uncertain' ? 'writerUncertainNotice' : 'writerNotice')}
      </BannerTitle>
      <BannerActions>
        <Button
          size="compact"
          variant="secondary"
          render={
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId }}
              search={{ panel: 'terminal', terminal: terminal.terminalId }}
            />
          }
        >
          {t('openControls')}
        </Button>
      </BannerActions>
    </Banner>
  );
}
