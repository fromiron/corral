import type { WorkSession } from '@corral/core';
import { useNavigate } from '@tanstack/react-router';
import { useRef } from 'react';
import { useTranslations } from 'use-intl';
import { useRegisterCommands } from '../commandRegistry.ts';
import { desktop } from '../desktop.tsx';
import { shortcutLabel } from '../shortcuts.ts';
import { sessionJumpTarget } from './sessionOrder.ts';

/** Mod+1–9 opens the current project's Nth session in sidebar order (desktop only). */
export function useSessionJump(sessions: WorkSession[], projectId: string | undefined) {
  const ts = useTranslations('Shortcuts');
  const tp = useTranslations('CommandPalette');
  const navigate = useNavigate();
  const current = useRef({ sessions, projectId });
  current.current = { sessions, projectId };
  const any = Boolean(projectId && sessions.some((s) => s.projectId === projectId));
  useRegisterCommands(
    'session-jump',
    desktop
      ? [
          {
            id: 'session:jump',
            title: ts('sessionJump'),
            group: tp('groups.sessions'),
            shortcutId: 'session.jump',
            shortcut: shortcutLabel('session.jump'),
            disabled: !any,
            run: () => {},
            jump: (digit) => {
              const target = sessionJumpTarget(
                current.current.sessions,
                current.current.projectId,
                digit,
              );
              if (target)
                void navigate({
                  to: '/sessions/$sessionId',
                  params: { sessionId: target.sessionId },
                });
            },
          },
        ]
      : [],
  );
}
