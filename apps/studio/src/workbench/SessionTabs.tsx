import type { WorkSession } from '@corral/core';
import { Button, Tooltip } from '@corral/react/design-kit';
import { X } from '@corral/react/icons';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { useRegisterCommands } from '../commandRegistry.ts';
import { desktop } from '../desktop.tsx';
import { useRemembered } from '../pages/Workbench.tsx';
import { useShortcutBindings } from '../shortcutBindings.ts';
import { shortcutLabel } from '../shortcuts.ts';

export function SessionTabs({ sessions }: { sessions: WorkSession[] }) {
  useShortcutBindings();
  const t = useTranslations('SessionTabs');
  const ts = useTranslations('Shortcuts');
  const tp = useTranslations('CommandPalette');
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
  const activeTab = useRef<HTMLAnchorElement>(null);
  const tabStrip = useRef<HTMLElement>(null);
  const visibleActiveId = visible.find((tab) => tab.sessionId === activeId)?.sessionId;
  const visibleLabels = JSON.stringify(visible.map(({ sessionId, title }) => [sessionId, title]));
  useEffect(() => {
    if (!visibleActiveId || !visibleLabels) return;
    const reveal = () => activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    window.addEventListener('resize', reveal);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    if (tabStrip.current) observer?.observe(tabStrip.current);
    return () => {
      window.removeEventListener('resize', reveal);
      observer?.disconnect();
    };
  }, [visibleActiveId, visibleLabels]);
  useRegisterCommands(
    'session-tabs',
    desktop
      ? [
          {
            id: 'session:jump',
            title: ts('sessionJump'),
            group: tp('groups.sessions'),
            shortcutId: 'session.jump',
            shortcut: shortcutLabel('session.jump'),
            disabled: !visible.length,
            run: () => {},
            jump: (digit) => {
              const tab = navigation.current[digit - 1];
              if (tab) void navigate({ href: tab.href });
            },
          },
        ]
      : [],
  );
  if (!visible.length) return null;
  return (
    <nav
      ref={tabStrip}
      aria-label={t('label')}
      className="session-tabs flex min-w-0 items-center gap-1 overflow-x-auto py-1"
    >
      {visible.map((tab, index) => (
        <div
          key={tab.sessionId}
          className={`flex shrink-0 items-center rounded ${tab.sessionId === activeId ? 'bg-subtle' : ''}`}
        >
          <a
            ref={tab.sessionId === activeId ? activeTab : undefined}
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
            className="max-w-48 truncate px-2 py-1.5 text-xs"
            title={tab.title}
          >
            {tab.title}
          </a>
          <Tooltip content={t('close', { title: tab.title })}>
            <Button
              variant="ghost"
              size="icon-compact"
              className="size-6 shrink-0"
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
            </Button>
          </Tooltip>
        </div>
      ))}
    </nav>
  );
}
