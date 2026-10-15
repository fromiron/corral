import type { RunEvent } from '@corral/contracts';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';

// Committed events of one run (C-060, OBS-001). Only the rows in view are in the DOM, so a run
// with 10,000 events costs the same as one with 50 (Spec §10.3). New events are appended
// below: the selection and the scroll position stay where the reader left them.

const ROW_HEIGHT = 28;

type ActorFilter = 'all' | RunEvent['actor']['kind'];

/** Event families, by the part of the type before the dot. */
function kindOf(event: RunEvent): string {
  return event.type.slice(0, event.type.indexOf('.'));
}

export function Timeline({ session }: { session: RunSessionStore }) {
  const t = useTranslations('Timeline');
  const events = useStore(session, (s) => s.events);
  const [actor, setActor] = useState<ActorFilter>('all');
  const [kind, setKind] = useState('all');
  const [execution, setExecution] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const kinds = useMemo(() => [...new Set(events.map(kindOf))].sort(), [events]);
  const executions = useMemo(
    () => [...new Set(events.flatMap((e) => (e.executionId ? [e.executionId] : [])))],
    [events],
  );
  const shown = useMemo(
    () =>
      events.filter(
        (e) =>
          (actor === 'all' || e.actor.kind === actor) &&
          (kind === 'all' || kindOf(e) === kind) &&
          (execution === 'all' || e.executionId === execution),
      ),
    [events, actor, kind, execution],
  );
  const selected = events.find((e) => e.eventId === selectedId) ?? null;

  const rows = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => shown[index]?.eventId ?? index,
  });

  const filter = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    options: [string, string][],
  ) => (
    <label className="flex flex-col gap-0.5 text-xs">
      <span className="text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-line bg-surface px-1 py-0.5"
      >
        <option value="all">{t('all')}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section aria-labelledby="timeline-heading" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="timeline-heading" className="text-xs font-semibold">
          {t('heading')}
        </h3>
        <span className="text-xs text-muted" data-testid="timeline-count">
          {t('count', { shown: shown.length, total: events.length })}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {filter(t('actor'), actor, (v) => setActor(v as ActorFilter), [
          ['user', t('actors.user')],
          ['runtime', t('actors.runtime')],
          ['agent', t('actors.agent')],
        ])}
        {filter(
          t('kind'),
          kind,
          setKind,
          kinds.map((k) => [k, k]),
        )}
        {filter(
          t('execution'),
          execution,
          setExecution,
          executions.map((id) => [id, id]),
        )}
      </div>
      <div
        ref={scrollRef}
        data-testid="timeline-scroll"
        className="h-80 overflow-auto rounded-md border border-line"
      >
        {shown.length === 0 ? (
          <p className="p-2 text-xs text-muted">{t('empty')}</p>
        ) : (
          <ul
            aria-label={t('heading')}
            className="relative"
            style={{ height: rows.getTotalSize() }}
          >
            {rows.getVirtualItems().map((item) => {
              const event = shown[item.index];
              if (!event) return null;
              const isSelected = event.eventId === selectedId;
              return (
                <li
                  key={item.key}
                  data-testid="timeline-row"
                  data-seq={event.runSeq}
                  className="absolute left-0 w-full"
                  style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                >
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedId(event.eventId)}
                    className={`flex h-full w-full items-center gap-2 px-2 text-left font-mono text-xs ${
                      isSelected ? 'bg-accent/15' : 'hover:bg-surface'
                    }`}
                  >
                    <span className="w-12 shrink-0 text-muted">#{event.runSeq}</span>
                    <span className="w-16 shrink-0">{t(`actors.${event.actor.kind}`)}</span>
                    <span className="truncate">{event.type}</span>
                    {event.executionId ? (
                      <span className="ml-auto shrink-0 text-muted">{event.executionId}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="rounded-md border border-line p-2 text-xs" data-testid="timeline-selected">
        <h4 className="font-semibold">{t('selected')}</h4>
        {selected ? (
          <dl className="grid grid-cols-[6rem_1fr] gap-x-2">
            <dt className="text-muted">#</dt>
            <dd>{selected.runSeq}</dd>
            <dt className="text-muted">type</dt>
            <dd>{selected.type}</dd>
            <dt className="text-muted">actor</dt>
            <dd>
              {selected.actor.kind}:{selected.actor.id}
            </dd>
            <dt className="text-muted">recordedAt</dt>
            <dd>{selected.recordedAt}</dd>
          </dl>
        ) : (
          <p className="text-muted">{t('none')}</p>
        )}
      </div>
    </section>
  );
}
