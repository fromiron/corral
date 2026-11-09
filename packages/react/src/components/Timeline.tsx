import type { RunEvent } from '@corral/contracts';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bot, Cog, type LucideIcon, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  formatJson,
  highlightJson,
  KitButton,
  KitCard,
  KitCardAction,
  KitCardContent,
  KitCardHeader,
  KitCardTitle,
  Select,
} from '../design-kit/index.ts';
import { formatClock } from '../design-kit/lib/agent-format.ts';
import { useRunDisplay } from '../run/display.tsx';
import type { RunSessionStore } from '../run/session.ts';
import { EventText } from './RunText.tsx';

// Committed events of one run. Only the rows in view are in the DOM, so a run
// with 10,000 events costs the same as one with 50. New events are appended
// below: the selection and the scroll position stay where the reader left them.

const ROW_HEIGHT = 36;

type ActorFilter = 'all' | RunEvent['actor']['kind'];

/** Event families, by the part of the type before the dot. */
function kindOf(event: RunEvent): string {
  return event.type.slice(0, event.type.indexOf('.'));
}

export function Timeline({
  session,
  selectedSeq,
  onSelectSeq,
  fill = false,
  onOpenExecution,
}: {
  session: RunSessionStore;
  selectedSeq?: number | undefined;
  onSelectSeq?: (seq: number) => void;
  /** Opens the execution an event belongs to. */
  onOpenExecution?: (executionId: string) => void;
  /** Fill the parent's height (the run workspace) instead of a fixed list height. */
  fill?: boolean;
}) {
  const t = useTranslations('Timeline');
  const format = useFormatter();
  const startedAt = useRunDisplay(session, (s) => s.projection?.startedAt ?? null);
  const events = useRunDisplay(session, (s) => s.events);
  const executionViews = useRunDisplay(session, (s) => s.projection?.executions);
  const iterations = useRunDisplay(session, (s) => s.projection?.iterations);
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
  // Executions are chosen by agent, round and attempt; identifiers stay out of the list.
  const executionOptions = useMemo(() => {
    const seen = new Map<string, number>();
    return executions.map((id): [string, string] => {
      const view = executionViews?.[id];
      const round = view?.iterationId ? iterations?.[view.iterationId]?.no : null;
      const nodeId = view?.nodeId;
      const base = [
        (nodeId && definition?.nodes.find((n) => n.id === nodeId)?.label) || nodeId || id,
        round ? t('round', { no: round }) : null,
        view && view.attemptNo > 1 ? t('attempt', { no: view.attemptNo }) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return [id, count > 1 ? `${base} (${count})` : base];
    });
  }, [executions, executionViews, iterations, definition, t]);
  const origin = useMemo(() => {
    const first = startedAt ?? events[0]?.recordedAt;
    return first ? Date.parse(first) : null;
  }, [startedAt, events]);
  const elapsed = (event: RunEvent) =>
    origin === null ? '' : `+${formatClock(Date.parse(event.recordedAt) - origin)}`;
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
  const selected =
    events.find((e) =>
      selectedSeq !== undefined ? e.runSeq === selectedSeq : e.eventId === selectedId,
    ) ?? null;

  // Choosing an event from elsewhere (a cause) clears filters that hide it and brings it into view.
  const [reveal, setReveal] = useState<string | null>(null);
  const choose = (event: RunEvent) => {
    if (!shown.includes(event)) {
      setActor('all');
      setKind('all');
      setExecution('all');
    }
    setSelectedId(event.eventId);
    onSelectSeq?.(event.runSeq);
    setReveal(event.eventId);
  };
  const causes = selected
    ? selected.causedByEventIds.flatMap((id) => {
        const cause = events.find((e) => e.eventId === id);
        return cause ? [cause] : [];
      })
    : [];

  const rows = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => shown[index]?.eventId ?? index,
  });

  useEffect(() => {
    if (!reveal) return;
    const index = shown.findIndex((e) => e.eventId === reveal);
    if (index < 0) return;
    rows.scrollToIndex(index, { align: 'center' });
    setReveal(null);
  }, [reveal, shown, rows]);

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
    <section
      aria-labelledby="timeline-heading"
      className={
        fill
          ? // The detail column exists only once an event is chosen; until then the list is full width.
            `@container flex h-full flex-col gap-4 p-4${selected ? ' @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_18rem] @3xl:items-start' : ''}`
          : 'flex flex-col gap-4'
      }
    >
      <KitCard className={fill ? 'flex min-h-0 flex-1 flex-col @3xl:h-full' : undefined}>
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
        <KitCardContent
          className={fill ? 'flex min-h-0 flex-1 flex-col gap-3' : 'flex flex-col gap-3'}
        >
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
            {filter(t('execution'), execution, setExecution, executionOptions)}
          </div>
          <div
            data-testid="timeline-columns"
            aria-hidden
            className="flex gap-1.5 border-b border-border px-4 pb-1.5 text-caption text-muted-foreground"
          >
            <span className="w-12 shrink-0">#</span>
            <span className="w-14 shrink-0">{t('elapsed')}</span>
            <span className="w-20 shrink-0">{t('actor')}</span>
            <span className="min-w-0 flex-1">{t('event')}</span>
            <span className="shrink-0">{t('kind')}</span>
          </div>
          <div
            ref={scrollRef}
            data-testid="timeline-scroll"
            className={fill ? 'min-h-48 flex-1 overflow-auto' : 'h-80 overflow-auto'}
          >
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
                  const isSelected = event.eventId === selected?.eventId;
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
                        onClick={() => {
                          setSelectedId(event.eventId);
                          onSelectSeq?.(event.runSeq);
                        }}
                        className="w-full justify-start text-left [&>span:last-child]:contents [&>span:last-child>span]:contents"
                      >
                        <span className="w-12 shrink-0 font-mono text-muted-foreground">
                          #{event.runSeq}
                        </span>
                        <span className="w-14 shrink-0 text-muted-foreground tabular-nums">
                          {elapsed(event)}
                        </span>
                        <span className="flex w-20 shrink-0 items-center gap-1.5">
                          <ActorIcon kind={event.actor.kind} />
                          {t(`actors.${event.actor.kind}`)}
                        </span>
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
      {selected ? (
        <KitCard data-testid="timeline-selected">
          <KitCardHeader>
            <h4>
              <KitCardTitle>{t('selected')}</KitCardTitle>
            </h4>
          </KitCardHeader>
          <KitCardContent className="grid gap-4">
            <div className="grid gap-1">
              <p className="text-foreground">
                <EventText event={selected} labelOf={labelOf} nodeLabel={nodeLabel} />
              </p>
              <p className="text-caption text-muted-foreground tabular-nums">
                {format.dateTime(new Date(selected.recordedAt), {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                })}{' '}
                · {elapsed(selected)}
              </p>
            </div>
            {causes.length ? (
              <section aria-label={t('causes')} className="grid gap-1">
                <h5 className="text-caption text-muted-foreground">{t('causes')}</h5>
                <ul className="grid gap-0.5">
                  {causes.map((cause) => (
                    <li key={cause.eventId}>
                      <KitButton
                        type="button"
                        variant="ghost"
                        size="compact"
                        className="w-full justify-start text-left"
                        onClick={() => choose(cause)}
                      >
                        <span className="shrink-0 font-mono text-muted-foreground">
                          #{cause.runSeq}
                        </span>
                        <span className="min-w-0 truncate">
                          <EventText event={cause} labelOf={labelOf} nodeLabel={nodeLabel} />
                        </span>
                      </KitButton>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {selected.executionId ? (
              <section aria-label={t('execution')} className="grid gap-1">
                <h5 className="text-caption text-muted-foreground">{t('execution')}</h5>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {executionOptions.find(([id]) => id === selected.executionId)?.[1] ??
                      labelOf(selected.executionId)}
                  </span>
                  {onOpenExecution ? (
                    <KitButton
                      type="button"
                      variant="secondary"
                      size="compact"
                      onClick={() => selected.executionId && onOpenExecution(selected.executionId)}
                    >
                      {t('openExecution')}
                    </KitButton>
                  ) : null}
                </div>
              </section>
            ) : null}
            <section aria-label={t('payload')} className="grid gap-1">
              <h5 className="text-caption text-muted-foreground">{t('payload')}</h5>
              <pre className="m-0 max-h-[50vh] overflow-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-caption whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] [tab-size:2]">
                <code>{highlightJson(formatJson(selected.payload))}</code>
              </pre>
            </section>
          </KitCardContent>
        </KitCard>
      ) : null}
    </section>
  );
}

/** Who recorded an event, recognisable at a glance; runtime records, the most common, stay quiet. */
const ACTOR_ICONS: Record<RunEvent['actor']['kind'], { Icon: LucideIcon; color: string }> = {
  user: { Icon: User, color: 'var(--emphasis)' },
  agent: { Icon: Bot, color: 'var(--foreground)' },
  runtime: { Icon: Cog, color: 'var(--muted-foreground)' },
};

function ActorIcon({ kind }: { kind: RunEvent['actor']['kind'] }) {
  const { Icon, color } = ACTOR_ICONS[kind];
  return (
    <Icon size={14} aria-hidden data-actor-icon={kind} className="shrink-0" style={{ color }} />
  );
}
