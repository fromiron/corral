import type { CorralDefinition, RunEvent } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { executionIntervals, StatusBadge } from '@corral/react';
import { Button } from '@corral/react/design-kit';
import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'use-intl';

/** Observed lifetimes include waits; each retry and Loop execution keeps its own row. */
export function RunTimeChart({
  events,
  projection,
  definition,
  selected,
  onSelect,
}: {
  events: RunEvent[];
  projection: RunProjection | null;
  definition: CorralDefinition;
  selected: string | undefined;
  onSelect: (executionId: string) => void;
}) {
  const t = useTranslations('RunMonitor');
  const stateText = useTranslations('Canvas.nodeStatus');
  const format = useFormatter();
  const rows = useMemo(() => executionIntervals(events), [events]);
  if (!rows.length) return <p className="p-3 text-sm text-muted-foreground">{t('noIntervals')}</p>;
  const start = Math.min(...rows.map((row) => Date.parse(row.startedAt)));
  const end = Math.max(...rows.map((row) => Date.parse(row.endedAt)));
  const width = Math.max(1, end - start);
  const milliseconds = (value: number) =>
    t('milliseconds', { value: format.number(value, { maximumFractionDigits: 0 }) });
  return (
    <section aria-label={t('time')} className="h-full overflow-auto p-3">
      <p className="mb-3 text-xs text-muted-foreground">{t('lifespanNote')}</p>
      <ol className="flex flex-col gap-2">
        {rows.map((row) => {
          const node = definition.nodes.find((node) => node.id === row.nodeId);
          const round = row.iterationId ? projection?.iterations[row.iterationId]?.no : null;
          const duration = Math.max(0, Date.parse(row.endedAt) - Date.parse(row.startedAt));
          return (
            <li key={row.executionId} className="flex min-w-0 flex-col gap-2">
              <Button
                variant={selected === row.executionId ? 'secondary' : 'ghost'}
                className="self-start"
                aria-label={`${node?.label ?? row.nodeId} · ${row.executionId}`}
                aria-pressed={selected === row.executionId}
                onClick={() => onSelect(row.executionId)}
              >
                {node?.label ?? row.nodeId}
              </Button>
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 break-all font-mono">{row.executionId}</span>
                {round ? <span>{t('iteration', { number: round })}</span> : null}
                <span>{t('attempt', { number: row.attemptNo })}</span>
                <StatusBadge status={row.status} />
                <span className="text-muted-foreground">
                  {milliseconds(duration)}
                  {row.finished ? '' : ` · ${t('lastObserved')}`}
                </span>
              </div>
              <span
                role="img"
                aria-label={t('lifespan', { start: row.startedAt, end: row.endedAt })}
                className="relative block h-3 w-full rounded bg-muted"
              >
                {row.segments.map((segment) => {
                  const status =
                    segment.status === 'active' ? (segment.activity ?? 'active') : segment.status;
                  return (
                    <span
                      key={segment.startSeq}
                      title={`${stateText(status)} · #${segment.startSeq}–#${segment.endSeq}`}
                      className={`absolute top-0 h-full rounded-sm ${segment.status === 'active' ? 'bg-primary' : 'bg-warning/60'}`}
                      style={{
                        left: `${((Date.parse(segment.startedAt) - start) / width) * 100}%`,
                        width: `${(Math.max(0, Date.parse(segment.endedAt) - Date.parse(segment.startedAt)) / width) * 100}%`,
                        minWidth: '1px',
                      }}
                    />
                  );
                })}
              </span>
              {selected === row.executionId && row.calls.length ? (
                <span className="flex min-w-0 flex-wrap gap-x-4 text-xs text-muted-foreground">
                  {row.calls.map((call) => (
                    <span key={`${call.kind}:${call.callId}`} className="min-w-0 break-all">
                      {t(call.kind)} · {call.callId} · {milliseconds(call.durationMs)}
                    </span>
                  ))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
