import type { WorkSession } from '@corral/core';
import { X } from '@corral/react/icons';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { desktop } from '../desktop.tsx';
import { useRemembered } from '../pages/Workbench.tsx';

export function SessionTabs({ sessions }: { sessions: WorkSession[] }) {
  const t = useTranslations('SessionTabs');
  const location = useRouterState({ select: (state) => state.location });
  const navigate = useNavigate();
  const activeId = /^\/sessions\/([^/]+)(?:\/|$)/.exec(location.pathname)?.[1];
  const active = sessions.find((session) => session.sessionId === activeId);
  const [stored, setStored] = useRemembered<{ sessionId: string; href: string }[]>(
    'corral:session-tabs:v1',
    [],
  );
  const tabs = (Array.isArray(stored) ? stored : []).filter(
    (tab, index, all) =>
      tab &&
      typeof tab.sessionId === 'string' &&
      typeof tab.href === 'string' &&
      tab.href.startsWith(`/sessions/${encodeURIComponent(tab.sessionId)}`) &&
      all.findIndex((other) => other?.sessionId === tab.sessionId) === index,
  );
  const currentSessionId = active?.sessionId;
  const current = useRef({ tabs, setStored });
  current.current = { tabs, setStored };
  useEffect(() => {
    if (!currentSessionId) return;
    const { tabs, setStored } = current.current;
    const entry = { sessionId: currentSessionId, href: location.href };
    setStored(
      tabs.some((tab) => tab.sessionId === currentSessionId)
        ? tabs.map((tab) => (tab.sessionId === currentSessionId ? entry : tab))
        : [...tabs, entry],
    );
  }, [currentSessionId, location.href]);
  const visible = tabs.flatMap((tab) => {
    const session = sessions.find((session) => session.sessionId === tab.sessionId);
    return session ? [{ ...tab, title: session.title }] : [];
  });
  const navigation = useRef(visible);
  navigation.current = visible;
  useEffect(() => {
    if (!desktop) return;
    const select = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        !/^[1-9]$/.test(event.key)
      )
        return;
      const tab = navigation.current[Number(event.key) - 1];
      if (tab) {
        event.preventDefault();
        void navigate({ href: tab.href });
      }
    };
    window.addEventListener('keydown', select);
    return () => window.removeEventListener('keydown', select);
  }, [navigate]);
  if (!visible.length) return null;
  return (
    <nav
      aria-label={t('label')}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1"
    >
      {visible.map((tab, index) => (
        <div
          key={tab.sessionId}
          className={`flex shrink-0 items-center rounded ${tab.sessionId === activeId ? 'bg-subtle' : ''}`}
        >
          <a
            href={tab.href}
            aria-current={tab.sessionId === activeId ? 'page' : undefined}
            onClick={(event) => {
              if (
                event.button === 0 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey
              ) {
                event.preventDefault();
                void navigate({ href: tab.href });
              }
            }}
            className="max-w-48 truncate px-2 py-1 text-xs"
            title={tab.title}
          >
            {tab.title}
          </a>
          <button
            type="button"
            className="rounded p-1 text-muted hover:text-text"
            aria-label={t('close', { title: tab.title })}
            onClick={() => {
              setStored(tabs.filter((item) => item.sessionId !== tab.sessionId));
              if (tab.sessionId === activeId) {
                const next = visible[index - 1] ?? visible[index + 1];
                if (next) void navigate({ href: next.href });
                else void navigate({ to: '/projects' });
              }
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </nav>
  );
}
