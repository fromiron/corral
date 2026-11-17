import type { RunSummary, WorkSession } from '@corral/core';
import {
  Button,
  fontWeights,
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '@corral/react/design-kit';
import { ChevronDown } from '@corral/react/icons';
import { useFormatter, useTranslations } from 'use-intl';
import { PresenceMark } from './PresenceMark.tsx';
import { latestSessionRun, listedRunPresence } from './sessionList.ts';
import { bySidebarOrder } from './sessionOrder.ts';

// Each segment of the top bar's path is the menu for its level (project / session), so moving
// between siblings needs neither the sidebar nor a second row of controls. The path ends at the
// session: runs are chosen in the session panel's tabs and its "+" list.

const crumb = 'min-w-0 gap-1 px-2';

/**
 * The session segment: the page title, and the project's sessions in sidebar order. Its menu only
 * chooses a session; the session's actions are in the top bar's more menu (SessionActions.tsx).
 */
export function SessionMenu({
  sessions,
  runs,
  projectId,
  sessionId,
  title,
  onOpen,
}: {
  sessions: readonly WorkSession[];
  runs: readonly RunSummary[];
  projectId: string;
  sessionId: string;
  title: string;
  onOpen: (sessionId: string) => void;
}) {
  const n = useTranslations('Navigation');
  const presenceText = useTranslations('Presence');
  const format = useFormatter();
  const siblings = sessions
    .filter((session) => session.projectId === projectId && !session.archivedAt)
    .sort(bySidebarOrder);
  return (
    // The name a narrowing bar keeps: it is the last thing to shorten (topbarTier.ts).
    <h2 data-crumb="current" className="flex max-w-64 min-w-0">
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="compact"
              className={`${crumb} max-w-full text-foreground`}
            />
          }
        >
          <span
            data-crumb-label=""
            className="truncate"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {title}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup align="start" aria-label={n('switchSession')} className="max-w-96 min-w-64">
          <MenuRadioGroup value={sessionId} onValueChange={(value) => onOpen(String(value))}>
            {siblings.map((session) => {
              const run = latestSessionRun(session, runs);
              const presence = run ? listedRunPresence(run) : null;
              return (
                <MenuRadioItem
                  key={session.sessionId}
                  value={session.sessionId}
                  // The item's name is its title and its state: the mark alone is not read.
                  label={
                    presence
                      ? format.list([session.title, presenceText(presence.labelKey)], {
                          type: 'unit',
                        })
                      : session.title
                  }
                  closeOnClick
                >
                  {/* A grid, not a flex row: its title column asks for no width of its own, so a
                      long title truncates inside the popup and the status keeps its place. */}
                  <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                    <span className="truncate">{session.title}</span>
                    {/* The mark and its name only: the open conversation says the state in words. */}
                    {presence ? <PresenceMark presence={presence} /> : null}
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </h2>
  );
}
