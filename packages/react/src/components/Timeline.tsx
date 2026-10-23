import type { RunEvent } from '@corral/contracts';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  KitButton,
  KitCard,
  KitCardAction,
  KitCardContent,
  KitCardHeader,
  KitCardTitle,
  Select,
} from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { EventText } from './RunText.tsx';

// Committed events of one run (C-060, OBS-001). Only the rows in view are in the DOM, so a run
// with 10,000 events costs the same as one with 50 (Spec §10.3). New events are appended
// below: the selection and the scroll position stay where the reader left them.

const ROW_HEIGHT = 36;

type ActorFilter = 'all' | RunEvent['actor']['kind'];

/** Event families, by the part of the type before the dot. */
function kindOf(event: RunEvent): string {
  return event.type.slice(0, event.type.indexOf('.'));
}

export function Timeline({ session }: { session: RunSessionStore }) {
  const t = useTranslations('Timeline');
  const events = useStore(session, (s) => s.events);
  const executionViews = useStore(session, (s) => s.projection?.executions);
  const definition = useStore(session, (s) => s.definition);
  const nodeLabel = (nodeId: string) =>
    definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const labelOf = (executionId: string | undefined) => {
    const nodeId = executionId ? executionViews?.[executionId]?.nodeId : undefined;
    return nodeId ? nodeLabel(nodeId) : (executionId ?? '');
  };
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
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      <Select
        label={label}
        value={value}
        onValueChange={onChange}
        options={[
          { value: 'all', label: t('all') },
          ...options.map(([value, label]) => ({ value, label })),
        ]}
      />
    </div>
  );

  return (
    <section aria-labelledby="timeline-heading" className="flex flex-col gap-4">
      <KitCard>
        <KitCardHeader>
          <h3 id="timeline-heading">
            <KitCardTitle>{t('heading')}</KitCardTitle>
          </h3>
          <KitCardAction>
            <span className="text-muted-foreground" data-testid="timeline-count">
              {t('count', { shown: shown.length, total: events.length })}
            </span>
          </KitCardAction>
        </KitCardHeader>
        <KitCardContent className="flex flex-col gap-3">
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
          <div ref={scrollRef} data-testid="timeline-scroll" className="h-80 overflow-auto">
            {shown.length === 0 ? (
              <p className="text-muted-foreground">{t('empty')}</p>
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
                      <KitButton
                        type="button"
                        variant={isSelected ? 'secondary' : 'ghost'}
                        size="default"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedId(event.eventId)}
                        className="w-full justify-start text-left [&>span:last-child]:contents [&>span:last-child>span]:contents"
                      >
                        <span className="w-12 shrink-0 font-mono text-muted-foreground">
                          #{event.runSeq}
                        </span>
                        <span className="w-16 shrink-0">{t(`actors.${event.actor.kind}`)}</span>
                        <span className="min-w-0 truncate">
                          <EventText event={event} labelOf={labelOf} nodeLabel={nodeLabel} />
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                          {event.type}
                        </span>
                      </KitButton>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </KitCardContent>
      </KitCard>
      <KitCard data-testid="timeline-selected">
        <KitCardHeader>
          <h4>
            <KitCardTitle>{t('selected')}</KitCardTitle>
          </h4>
        </KitCardHeader>
        <KitCardContent>
          {selected ? (
            <dl className="grid grid-cols-[6rem_1fr] gap-x-2">
              <dt className="text-muted-foreground">#</dt>
              <dd>{selected.runSeq}</dd>
              <dt className="text-muted-foreground">type</dt>
              <dd>{selected.type}</dd>
              <dt className="text-muted-foreground">actor</dt>
              <dd>
                {selected.actor.kind}:{selected.actor.id}
              </dd>
              <dt className="text-muted-foreground">recordedAt</dt>
              <dd>{selected.recordedAt}</dd>
            </dl>
          ) : (
            <p className="text-muted-foreground">{t('none')}</p>
          )}
        </KitCardContent>
      </KitCard>
    </section>
  );
}
