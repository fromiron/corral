import type { RunSummary, WorkSession } from '@corral/core';
import { StatusDot } from '@corral/react';
import {
  Button,
  fontWeights,
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@corral/react/design-kit';
import { ChevronDown } from '@corral/react/icons';
import { useTranslations } from 'use-intl';
import { useRegisteredCommands } from '../commandRegistry.ts';
import { bySidebarOrder } from './sessionOrder.ts';

// Each segment of the top bar's path is the menu for its level (project / session / run), so
// moving between siblings needs neither the sidebar nor a second row of controls.

const crumb = 'min-w-0 gap-1 px-2';

// The open page registers its own session actions with their revision checks
// (session/SessionActions.tsx, or MeetingPage for a meeting); the path's menu runs those.
const SESSION_ACTIONS = ['session:rename', 'session:pin', 'session:archive'];

function latestRun(runs: readonly RunSummary[], sessionId: string) {
  let latest: RunSummary | undefined;
  for (const run of runs)
    if (run.sessionId === sessionId && (!latest || run.startedAt > latest.startedAt)) latest = run;
  return latest;
}

/** The session segment: the page title, and the project's sessions in sidebar order. */
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
  const status = useTranslations('Status');
  const siblings = sessions
    .filter((session) => session.projectId === projectId && !session.archivedAt)
    .sort(bySidebarOrder);
  const registered = useRegisteredCommands();
  const actions = SESSION_ACTIONS.flatMap(
    (id) => registered.find((command) => command.id === id) ?? [],
  );
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
          {actions.map((command) => (
            <MenuItem
              key={command.id}
              disabled={command.disabled}
              onClick={() => void command.run()}
            >
              {command.title}
            </MenuItem>
          ))}
          {actions.length ? <MenuSeparator /> : null}
          <MenuRadioGroup value={sessionId} onValueChange={(value) => onOpen(String(value))}>
            {siblings.map((session) => {
              const run = latestRun(runs, session.sessionId);
              const label = run ? (status.has(run.status) ? status(run.status) : run.status) : null;
              return (
                <MenuRadioItem key={session.sessionId} value={session.sessionId} closeOnClick>
                  {/* A grid, not a flex row: its title column asks for no width of its own, so a
                      long title truncates inside the popup and the status keeps its place. */}
                  <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                    <span className="truncate">{session.title}</span>
                    {run && label ? (
                      <span className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground">
                        <StatusDot status={run.status} />
                        <span>
                          <span className="sr-only"> · </span>
                          {label}
                        </span>
                      </span>
                    ) : null}
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

/**
 * The run segment of the run history: the chosen run's number, and a menu of the session's runs,
 * newest first, each named by its number and request summary (`names`).
 */
export function RunMenu({
  runs,
  runId,
  names = {},
  onSelect,
}: {
  runs: readonly RunSummary[];
  runId: string;
  /** A run's request summary, or its team's name when nothing was requested. */
  names?: Readonly<Record<string, string | null | undefined>>;
  onSelect: (runId: string) => void;
}) {
  const tw = useTranslations('Workbench');
  const tr = useTranslations('RunPage');
  const status = useTranslations('Status');
  const label = (run: RunSummary) => (status.has(run.status) ? status(run.status) : run.status);
  const number = (id: string) => runs.findIndex((run) => run.runId === id) + 1;
  const runName = (id: string) => {
    const name = names[id];
    return name
      ? tr('runName', { number: number(id), name })
      : tw('runNumber', { number: number(id) });
  };
  const chosen = runs.find((run) => run.runId === runId);
  const full = tw('runNumber', { number: number(runId) });
  const short = tw('runNumberShort', { number: number(runId) });
  const word = full.endsWith(short) ? full.slice(0, -short.length).trim() : '';
  // The run is its number: the run header below the bar names its request, and the menu lists
  // each run's request beside its number.
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="compact"
            data-crumb="extra"
            className={`${crumb} max-w-64 text-foreground`}
          />
        }
      >
        {chosen ? <StatusDot status={chosen.status} label={label(chosen)} /> : null}
        {word ? (
          // With no room for "Run #1", the number stands alone ("#1"), never a cut word: the
          // label is one line tall, and the word wraps above that line, out of sight.
          <span
            data-crumb-label=""
            className="relative flex h-lh min-w-0 flex-wrap content-end gap-x-1 overflow-hidden"
          >
            <span data-run-word className="whitespace-nowrap">{`${word} `}</span>
            <span data-run-number className="whitespace-nowrap">
              {short}
            </span>
            {/* The whole label's width, which the bar's fit reads (topbarTier.ts). */}
            <span aria-hidden="true" className="invisible absolute top-0 left-0 whitespace-nowrap">
              {full}
            </span>
          </span>
        ) : (
          <span data-crumb-label="" className="truncate">
            {full}
          </span>
        )}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" aria-label={tw('chooseRun')} className="min-w-48 max-w-96">
        <MenuRadioGroup value={runId} onValueChange={(value) => onSelect(String(value))}>
          {[...runs].reverse().map((run) => (
            <MenuRadioItem key={run.runId} value={run.runId} closeOnClick>
              <span className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                <StatusDot status={run.status} />
                <span className="truncate">{runName(run.runId)}</span>
                <span className="text-caption text-muted-foreground">
                  <span className="sr-only"> · </span>
                  {label(run)}
                </span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
