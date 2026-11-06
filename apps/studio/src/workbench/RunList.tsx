import type { RunSummary, WorkSession } from '@corral/core';
import { StatusBadge } from '@corral/react';
import { CheckboxGroup, CheckboxItem } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import {
  loadRunIdentities,
  type RunIdentity,
  runIdentity,
  runIdentityText,
} from './runIdentity.ts';

/** Mounted only while the project's Runs tab is open. */
export function RunList({
  runs,
  sessions,
  picked,
  onPick,
}: {
  runs: RunSummary[];
  sessions: WorkSession[];
  picked: string[];
  onPick(runId: string, selected: boolean): void;
}) {
  const t = useTranslations('RunIdentity');
  const format = useFormatter();
  const { transport } = useServices();
  const [identities, setIdentities] = useState<Record<string, RunIdentity>>({});
  useEffect(() => {
    let current = true;
    void loadRunIdentities(runs, runs, sessions, (id) => transport.getRunDefinition(id)).then(
      (next) => {
        if (current) setIdentities(next);
      },
    );
    return () => {
      current = false;
    };
  }, [runs, sessions, transport]);
  return (
    <ul className="flex flex-col" aria-labelledby="runs-heading">
      {runs.map((run) => {
        const name = runIdentityText(
          identities[run.runId] ?? runIdentity(run, runs, sessions),
          t('unnamed'),
          (number) => t('number', { number }),
        );
        return (
          <li
            key={run.runId}
            className="flex flex-wrap items-start gap-3 border-b border-line/50 py-2 text-sm last:border-b-0"
          >
            <CheckboxGroup
              checkedIndices={new Set(picked.includes(run.runId) ? [0] : [])}
              className="w-fit shrink-0"
            >
              <CheckboxItem
                index={0}
                label=""
                aria-label={t('select', { name })}
                checked={picked.includes(run.runId)}
                onToggle={() => onPick(run.runId, !picked.includes(run.runId))}
              />
            </CheckboxGroup>
            <StatusBadge status={run.status} />
            <div className="min-w-0 flex-1">
              <Link
                to="/runs/$runId"
                params={{ runId: run.runId }}
                className="break-words hover:underline"
              >
                {name}
              </Link>
              <time dateTime={run.startedAt} className="block text-xs text-muted-foreground">
                {format.dateTime(new Date(run.startedAt), {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                })}
              </time>
              <details className="text-xs text-muted-foreground">
                <summary>{t('details')}</summary>
                <code className="select-text break-all">{run.runId}</code>
              </details>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
