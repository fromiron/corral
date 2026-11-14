import type { RunProjection } from '@corral/core';
import { type Presence, presenceTextClass, projectionPresence } from '@corral/react';
import { AgentCard, AgentStatusIcon, AgentSteeringPlan, cn } from '@corral/react/design-kit';
import { ChevronRight } from '@corral/react/icons';
import { type ReactNode, useState } from 'react';
import { useTranslations } from 'use-intl';

type PlanItem = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' };

const ENDED = new Set<Presence['kind']>(['succeeded', 'failed', 'interrupted', 'cancelled']);

/** The Run's glyph, in its tone's colour: the shape alone says the state (presence.md). */
function RunGlyph({ presence }: { presence: Presence }) {
  return presence.glyph ? (
    <span className={cn('inline-flex shrink-0', presenceTextClass(presence.tone))}>
      <AgentStatusIcon status={presence.glyph} size={12} colored={false} />
    </span>
  ) : null;
}

/**
 * The kit's AgentRun plan card, shown only when the planning tool recorded a work plan. Without
 * one there is no card.
 */
export function RunPlanCard({
  projection,
  plan,
}: {
  projection: RunProjection;
  plan: { items: readonly PlanItem[] } | null;
}) {
  const tw = useTranslations('Widgets');
  if (!plan?.items.length) return null;
  const presence = projectionPresence(projection);
  const live = !ENDED.has(presence.kind);
  const done = plan.items.filter((item) => item.status === 'completed').length;
  return (
    <AgentCard data-testid="run-plan-card" className="grid gap-2 p-4">
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <RunGlyph presence={presence} />
        <span>{tw('planHeading')}</span>
        <span className="ml-auto tabular-nums">
          {tw('planCount', { done, total: plan.items.length })}
        </span>
      </p>
      <AgentSteeringPlan
        steps={plan.items.map((item) => ({
          id: item.id,
          title: item.title,
          status:
            item.status === 'completed'
              ? 'done'
              : item.status === 'in_progress'
                ? 'active'
                : 'pending',
        }))}
        status={live ? 'running' : 'waiting'}
        labels={{ plan: tw('planHeading') }}
        statusLabel={(state) =>
          tw(state === 'done' ? 'completed' : state === 'active' ? 'in_progress' : 'pending')
        }
        wrapTitles
      />
    </AgentCard>
  );
}

/**
 * The work plan as one folded line above the work flow: progress and the step in hand. Opening it
 * shows the full plan, or every plan when several were recorded. Without a plan there is no line.
 */
export function RunPlanStrip({
  projection,
  plan,
  planCount,
  allPlans,
}: {
  projection: RunProjection;
  plan: { items: readonly PlanItem[] } | null;
  planCount: number;
  allPlans: ReactNode;
}) {
  const tw = useTranslations('Widgets');
  const tm = useTranslations('RunMonitor');
  const [open, setOpen] = useState(false);
  const items = plan?.items ?? [];
  if (!items.length && planCount < 2) return null;
  const several = planCount > 1;
  const done = items.filter((item) => item.status === 'completed').length;
  const current =
    items.find((item) => item.status === 'in_progress') ??
    items.find((item) => item.status === 'pending');
  return (
    <div className="grid gap-2" data-testid="run-plan-strip">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption text-muted-foreground hover:bg-hover"
      >
        <ChevronRight
          aria-hidden
          size={14}
          className={cn('shrink-0 transition-transform', open && 'rotate-90')}
        />
        <RunGlyph presence={projectionPresence(projection)} />
        <span className="shrink-0 text-foreground">
          {several ? tm('planCount', { count: planCount }) : tw('planHeading')}
        </span>
        {items.length ? (
          <span className="shrink-0 tabular-nums">
            {tw('planCount', { done, total: items.length })}
          </span>
        ) : null}
        {current ? <span className="min-w-0 truncate">· {current.title}</span> : null}
      </button>
      {open ? several ? allPlans : <RunPlanCard projection={projection} plan={plan} /> : null}
    </div>
  );
}
