import { type ReactNode, useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { AgentSteering, type SteerStep } from '../design-kit/components/agent/agent-steering.tsx';
import { useAgentName, useSeverityName } from '../run/advisor.ts';
import { executionIntervals } from '../run/history.ts';
import { type Presence, type PresenceKind, runPresence } from '../run/presence.ts';
import { executionViewPresence } from '../run/projectionPresence.ts';
import type { RunSessionStore } from '../run/session.ts';
import { buildTranscript } from '../run/transcript.ts';
import { useWorkPlanSnapshot } from '../run/work-plan-snapshot.ts';
import { ExecutionToolGroup } from './ExecutionTranscript.tsx';
import type { SteerTarget } from './ReinsPanel.tsx';
import { StatusBadge } from './StatusBadge.tsx';

export interface ExecutionSteeringProps {
  session: RunSessionStore;
  target: SteerTarget;
  /** The host owns the draft, shortcuts and command lifecycle. */
  compose: ReactNode;
  /** Reuse the composer's selected plan, display preference and five-row disclosure. */
  planSlot?: ReactNode;
  headerActions?: ReactNode;
  /** Include observed tool activity when no adjacent execution transcript already presents it. */
  showToolActivity?: boolean;
  /** Contextual controls or observed ToolCallGroup activity. */
  children?: ReactNode;
  className?: string;
}

const ENDED = new Set<PresenceKind>(['succeeded', 'failed', 'interrupted', 'cancelled']);

/** Kit steering presentation for one explicit execution, without introducing another controller. */
export function ExecutionSteering({
  session,
  target,
  compose,
  planSlot,
  headerActions,
  showToolActivity = false,
  children,
  className,
}: ExecutionSteeringProps) {
  const t = useTranslations('Reins');
  const ts = useTranslations('Reins.steering');
  const tp = useTranslations('Presence');
  // A detail is said beside the state, never instead of it.
  const words = (presence: Presence) =>
    presence.detailKey
      ? `${tp(presence.labelKey)} · ${tp(presence.detailKey)}`
      : tp(presence.labelKey);
  const planText = useTranslations('WorkPlan');
  const activityText = useTranslations('RunPage.tabs');
  const adviceText = useTranslations('Advice');
  const severityName = useSeverityName();
  const runId = useStore(session, (s) => s.runId);
  const projection = useStore(session, (s) => s.projection);
  const events = useStore(session, (s) => s.events);
  const definition = useStore(session, (s) => s.definition);
  const nameOf = useAgentName(definition);
  const execution = projection?.executions?.[target.executionId];
  const planRef =
    planSlot !== undefined
      ? null
      : (Object.values(projection?.workPlans ?? {}).find(
          (plan) => plan.scope === 'execution' && plan.executionId === target.executionId,
        ) ?? null);
  const planBody = useStore(session, (s) =>
    planRef ? s.artifactTexts[planRef.bodyRef] : undefined,
  );
  const { status: plan } = useWorkPlanSnapshot({
    runId,
    ref: planRef,
    cacheScope: session,
    currentAttemptNo: execution?.attemptNo,
    currentCriteriaVersionId: projection?.currentCriteriaVersionId,
    runStatus: projection?.status,
    text: planBody,
    load: async (bodyRef, options) => {
      if (session.getState().runId !== runId) return null;
      await session.getState().loadArtifact(bodyRef, options);
      return session.getState().runId === runId
        ? (session.getState().artifactTexts[bodyRef] ?? null)
        : null;
    },
  });
  const steps: SteerStep[] =
    plan.state === 'ready'
      ? plan.plan.items.map((item) => ({
          id: item.id,
          title: item.title,
          status:
            item.status === 'completed'
              ? 'done'
              : item.status === 'in_progress'
                ? 'active'
                : 'pending',
        }))
      : [];
  const interval = useMemo(
    () => executionIntervals(events).find((row) => row.executionId === target.executionId),
    [events, target.executionId],
  );
  const tools = useMemo(
    () =>
      showToolActivity
        ? buildTranscript(events, projection, {}, target.executionId).filter(
            (entry) => entry.kind === 'tool',
          )
        : [],
    [showToolActivity, events, projection, target.executionId],
  );
  const directives = (projection?.directiveOrder ?? []).flatMap((id) => {
    const directive = projection?.directives[id];
    return directive?.targetExecutionId === target.executionId ? [directive] : [];
  });
  /** An advice's directive names its advisor and severity; the person's names nobody. */
  const adviceFrom = (advice: (typeof directives)[number]['advice']) => {
    if (!advice) return null;
    const nodeId = projection?.executions[advice.observerExecutionId]?.nodeId;
    // The advisor's name is isolated: a model-written override cannot turn the line around.
    return adviceText.rich('from', {
      advisor: nodeId ? nameOf(nodeId) : adviceText('advisor'),
      severity: severityName(advice.severity),
      isolate: (chunks) => <bdi>{chunks}</bdi>,
    });
  };
  const model = execution
    ? (projection?.modelProfiles?.[execution.modelProfile]?.modelId ?? execution.modelProfile)
    : undefined;
  // What the screen says comes from the presence rule (features/presence.md), never the bare
  // status: the execution's state is its own, and its Run's own state (not what the Run waits on
  // elsewhere) stands for its unfinished calls while the Run is not working.
  const own = execution ? executionViewPresence(execution) : null;
  const run = projection ? runPresence(projection, [], []) : null;
  const status = own ? (own.kind === 'paused' ? 'paused' : (own.glyph ?? 'queued')) : undefined;
  const timing = interval
    ? own?.kind === 'working' && !interval.finished
      ? { startedAt: Date.parse(interval.startedAt) }
      : { elapsedMs: Date.parse(interval.endedAt) - Date.parse(interval.startedAt) }
    : {};
  const owner = run?.kind === 'working' ? own : (run ?? own);
  const toolActivityState =
    owner && !(run?.kind === 'working' && owner.kind === 'working' && !owner.detail)
      ? {
          status:
            (run && ENDED.has(run.kind)) || (own && ENDED.has(own.kind))
              ? ('stopped' as const)
              : ('waiting' as const),
          label: words(owner),
        }
      : undefined;

  return (
    <AgentSteering
      title={target.nodeLabel}
      agent={model ?? target.executionId}
      subtitle={
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {model ? `${model} · ` : ''}
          {target.executionId}
        </span>
      }
      status={status}
      statusLabel={own ? words(own) : undefined}
      steps={steps}
      planSlot={planSlot}
      {...timing}
      queued={directives.map((d) => ({
        id: d.directiveId,
        domId: `directive-${d.directiveId}`,
        text: d.text,
        status: <StatusBadge status={d.status} />,
        detail: (
          <>
            {d.advice ? (
              <span data-directive-advice className="text-muted-foreground">
                {adviceFrom(d.advice)}
              </span>
            ) : null}
            <span className="font-mono text-muted-foreground">{d.directiveId}</span>
            {d.reason ? <p className="text-warning">{d.reason}</p> : null}
            {d.modelCallId && d.contextSnapshotId ? (
              <p className="text-muted-foreground">
                {t('requestLink', { request: d.modelCallId, snapshot: d.contextSnapshotId })}
              </p>
            ) : null}
            {d.status === 'delivered' &&
            Object.values(projection?.artifacts ?? {}).some(
              (a) => a.modelCallId === d.modelCallId,
            ) ? (
              <p>
                {t('produced', {
                  versions: Object.values(projection?.artifacts ?? {})
                    .filter((a) => a.modelCallId === d.modelCallId)
                    .map((a) => a.artifactVersionId)
                    .join(', '),
                })}
              </p>
            ) : null}
          </>
        ),
      }))}
      labels={{
        queued: t('history'),
        plan: planText('heading'),
        activity: activityText('activity'),
        // Everything the kit would otherwise say in its own English is named here.
        steps: (current, total) => ts('steps', { current, total }),
        pause: ts('pause'),
        resume: ts('resume'),
        now: ts('now'),
        remove: (text) => ts('remove', { text }),
        instruction: ts('instruction'),
        placeholder: ts('placeholder'),
        send: ts('send'),
        nextHint: ts('nextHint'),
        interruptHint: ts('interruptHint'),
        steered: ts('steered'),
        interrupted: ts('interrupted'),
        queuedAnnouncement: (text) => ts('queuedAnnouncement', { text }),
        interruptAnnouncement: (text) => ts('interruptAnnouncement', { text }),
      }}
      activityMaxHeight={showToolActivity ? 'min(25dvh, 12rem)' : undefined}
      emptyQueued={<p className="text-caption text-muted-foreground">{t('noHistory')}</p>}
      queueFooter={<p className="mt-2 text-caption text-muted-foreground">{t('deliveredNote')}</p>}
      compose={compose}
      headerActions={headerActions}
      className={className}
    >
      {children}
      {tools.length > 0 ? (
        <div className="px-3.5 pb-2.5">
          <ExecutionToolGroup tools={tools} activityState={toolActivityState} />
        </div>
      ) : null}
    </AgentSteering>
  );
}
