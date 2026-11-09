import type { RunSummary, WorkSession } from '@corral/core';
import { StatusDot } from '@corral/react';
import {
  Button,
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '@corral/react/design-kit';
import { ChevronDown } from '@corral/react/icons';
import { useTranslations } from 'use-intl';
import { bySidebarOrder } from './sessionOrder.ts';

// Each segment of the top bar's path is the menu for its level (project / session / run), so
// moving between siblings needs neither the sidebar nor a second row of controls.

const crumb = 'min-w-0 max-w-64 gap-1 px-2 font-medium';

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
  return (
    <h2 className="flex min-w-0">
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="compact" className={crumb} />}>
          <span className="truncate">{title}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup align="start" aria-label={n('switchSession')} className="max-w-96 min-w-64">
          <MenuRadioGroup value={sessionId} onValueChange={(value) => onOpen(String(value))}>
            {siblings.map((session) => {
              const run = latestRun(runs, session.sessionId);
              const label = run ? (status.has(run.status) ? status(run.status) : run.status) : null;
              return (
                <MenuRadioItem key={session.sessionId} value={session.sessionId} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
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

/** The run segment of the run history: the session's runs, newest first. */
export function RunMenu({
  runs,
  runId,
  onSelect,
}: {
  runs: readonly RunSummary[];
  runId: string;
  onSelect: (runId: string) => void;
}) {
  const tw = useTranslations('Workbench');
  const status = useTranslations('Status');
  const label = (run: RunSummary) => (status.has(run.status) ? status(run.status) : run.status);
  const number = (id: string) => runs.findIndex((run) => run.runId === id) + 1;
  const chosen = runs.find((run) => run.runId === runId);
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="compact" className={crumb} />}>
        {chosen ? <StatusDot status={chosen.status} label={label(chosen)} /> : null}
        <span className="truncate">{tw('runNumber', { number: number(runId) })}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" aria-label={tw('chooseRun')} className="min-w-48">
        <MenuRadioGroup value={runId} onValueChange={(value) => onSelect(String(value))}>
          {[...runs].reverse().map((run) => (
            <MenuRadioItem key={run.runId} value={run.runId} closeOnClick>
              <span className="flex items-center gap-2">
                <StatusDot status={run.status} />
                <span className="flex-1">{tw('runNumber', { number: number(run.runId) })}</span>
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
