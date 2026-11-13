import type { RunSummary } from '@corral/core';
import {
  ActivityBar,
  type ActivityBarLine,
  type ActivityBarRole,
  type ActivityTarget,
  type Presence,
} from '@corral/react';
import { type RefObject, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { SteerTarget } from '../composerIntent.ts';
import {
  ActivityAnnouncements,
  ActivityContext,
  actionLabel,
  ChangesChip,
  ComposerPlan,
  planCount,
  RunLink,
  unansweredAttention,
} from '../widgets/ChatWidgets.tsx';
import { OverviewAccess } from '../widgets/OverviewWidgets.tsx';
import { revealPendingTray, useRespondInConversation, useTrayStore } from './pendingTrayState.ts';
import { type ActivityRole, roleSeen, useActivity } from './useActivity.ts';

const toMs = (value: string | null | undefined) => (value ? Date.parse(value) : undefined);

/**
 * The composer's activity bar, wired: what the session's run and its roles do, what waits on the
 * person, and the run's controls (features/composer-flow.md "활동 바"). It says nothing that a
 * row or card on screen already says.
 */
export function ComposerActivity({
  sessionId,
  ownActive,
  target,
  targets,
  onJoin,
  onStop,
  onPause,
  onResume,
  onViewRun,
  request,
  viewingOther,
}: {
  sessionId: string;
  /** The session's run still going, or null. */
  ownActive: RunSummary | null;
  /** The execution an instruction goes to now. */
  target: string | null;
  /** The executions that take an instruction now. */
  targets: readonly SteerTarget[];
  onJoin: (executionId: string) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  /** Opens a run's record, for a role whose row is not in the conversation. */
  onViewRun?: (runId: string) => void;
  /** The request that started the running run. */
  request?: string;
  /** Another run than the running one is presented. */
  viewingOther: boolean;
}) {
  const t = useTranslations('Activity');
  const tp = useTranslations('Presence');
  const tw = useTranslations('Widgets');
  const ta = useTranslations('Approvals');
  const td = useTranslations('Docking');
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const activity = useActivity({ ownActive, target: target || null, anchor });
  const { input, line, model, store, projection } = activity;
  const tray = useTrayStore();
  const respond = useRespondInConversation();
  const run = input.run;
  const word = (presence: Presence) => tp(presence.labelKey);
  const stateOf = (presence: Presence, of: ActivityTarget) => ({ text: word(presence), target: of });
  const many = (run?.roles ?? 0) > 1;
  const showTray = () => (respond ? respond() : revealPendingTray(tray, sessionId));

  // The parts kept whole after the words: the plan's count, the change summary.
  const planStatus = model?.runId ? model.plan.status : null;
  const parts =
    model?.runId && ((planStatus && 'completed' in planStatus) || model.chips.includes('changes')) ? (
      <>
        {planStatus && 'completed' in planStatus ? (
          <span data-testid="activity-plan" className="whitespace-nowrap tabular-nums">
            {planCount(planStatus, tw)}
          </span>
        ) : null}
        {planStatus && 'completed' in planStatus && model.chips.includes('changes') ? (
          <span aria-hidden>·</span>
        ) : null}
        {model.chips.includes('changes') ? <ChangesChip model={model} /> : null}
      </>
    ) : null;

  /** A role's line: its activity, its name among several, its state where no row says it. */
  const roleLine = (role: ActivityRole, others: number, stateShown: boolean): ActivityBarLine => {
    const named = many ? role.name : null;
    const doing = role.activity;
    const text = doing
      ? named
        ? t('roleActivity', { name: named, activity: doing })
        : doing
      : (named ?? undefined);
    return {
      glyph: role.presence.glyph,
      tone: role.presence.tone,
      ...(stateShown && !doing && !others ? { state: stateOf(role.presence, `execution:${role.id}`) } : {}),
      ...(text
        ? { text: others ? `${t('rolesWorking', { count: others + 1 })} · ${text}` : text }
        : {}),
      parts,
      startedAt: toMs(role.startedAt),
      endedAt: toMs(role.endedAt),
    };
  };

  const decide = (approvalId: string, decision: 'approve' | 'reject') => {
    if (!store || deciding) return;
    setDeciding(true);
    void store
      .getState()
      .resolveApproval(approvalId, decision)
      .catch(() => undefined)
      .finally(() => setDeciding(false));
  };

  const closed = ((): ActivityBarLine | null => {
    switch (line.kind) {
      case 'none':
        return null;
      case 'disconnected':
        return {
          glyph: 'failed',
          tone: 'danger',
          warning: true,
          text: t(line.reason === 'lost' ? 'connectionLost' : 'recordLost'),
          ...(activity.retry ? { action: { label: t('retry'), onClick: activity.retry } } : {}),
        };
      case 'waiting': {
        const item = line.item;
        const approval =
          item?.kind === 'approval' && item.decidable && projection?.approvals[item.approvalId];
        const tool = approval ? approval.tool : undefined;
        return {
          glyph: 'waiting',
          tone: 'warning',
          ...(run && !input.visible.has(`run:${run.runId}`)
            ? { state: stateOf(run.presence, `run:${run.runId}`) }
            : {}),
          text: item ? item.subject : t('waiting', { count: line.count }),
          ...(approval
            ? {
                approval: {
                  subject: item.subject,
                  approveLabel: tool ? ta('approveTool') : ta(`approveAs.${approval.kind}`),
                  denyLabel: tool ? ta('rejectTool') : ta(`rejectAs.${approval.kind}`),
                  onApprove: () => decide(approval.approvalId, 'approve'),
                  onDeny: () => decide(approval.approvalId, 'reject'),
                  disabled: deciding,
                },
              }
            : { action: { label: t('view'), onClick: showTray } }),
        };
      }
      case 'role':
        return roleLine(line.role, line.others, true);
      case 'target':
        return roleLine(line.role, 0, line.stateShown);
      case 'summary': {
        if (!run) return null;
        const attention = unansweredAttention(model);
        return {
          glyph: run.presence.glyph,
          tone: run.presence.tone,
          ...(line.stateShown ? { state: stateOf(run.presence, `run:${run.runId}`) } : {}),
          ...(attention && model ? { text: actionLabel(model, tw), warning: true } : {}),
          parts,
          ...(attention && model
            ? {
                action: {
                  label: tw(model.failedExecutionId ? 'actionOpenFailure' : 'actionOpenRun'),
                  // The exact run's own place: its failed steps, else its record.
                  render: (
                    <RunLink model={model} executionId={model.failedExecutionId ?? undefined} />
                  ),
                },
              }
            : {}),
        };
      }
    }
  })();

  const steerable = new Set(targets.map((item) => item.id));
  const show = (role: ActivityRole) => () => scrollToRole(anchor, role.id, run, onViewRun);
  const roles: ActivityBarRole[] =
    run?.live && input.roles.length
      ? input.roles.map((role) => ({
          id: role.id,
          name: role.name,
          glyph: role.presence.glyph,
          tone: role.presence.tone,
          state: stateOf(role.presence, `execution:${role.id}`),
          stateShown: !roleSeen(input, role),
          ...(role.activity ? { activity: role.activity } : {}),
          startedAt: toMs(role.startedAt),
          endedAt: toMs(role.endedAt),
          target: role.id === target,
          onShow: show(role),
          ...(steerable.has(role.id) ? { onJoin: () => onJoin(role.id) } : {}),
        }))
      : [];
  const status = projection?.status;
  return (
    <div
      ref={anchor}
      data-testid="activity-bar"
      data-run={run ? run.presence.kind : 'none'}
      data-live={run?.live ? '' : undefined}
      data-line={line.kind}
    >
      <ActivityBar
        line={closed}
        end={model?.runId ? <OverviewAccess /> : undefined}
        roles={roles}
        plan={model?.runId ? <ComposerPlan variant="activity" /> : undefined}
        context={model?.runId ? <ActivityContext model={model} /> : undefined}
        controls={
          ownActive && projection
            ? {
                paused: status === 'paused',
                disabled: status === 'cancelling' || status === 'pausing',
                onPause,
                onResume,
                onStop,
                note: (
                  <>
                    {request ? (
                      <span className="sr-only">{td('activeRunTarget', { request })}</span>
                    ) : null}
                    {viewingOther ? (
                      <span role="note" className="sr-only">
                        {td('activeRunNotViewed')}
                      </span>
                    ) : null}
                  </>
                ),
              }
            : undefined
        }
        announcements={<ActivityAnnouncements model={model} />}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

/** To the role's row in the conversation; a role the conversation does not show opens its run. */
function scrollToRole(
  anchor: RefObject<HTMLElement | null>,
  executionId: string,
  run: { runId: string; lead: string | null } | null,
  onViewRun?: (runId: string) => void,
) {
  const view = anchor.current?.closest('[data-chat-view]');
  const row =
    view?.querySelector(`[data-chat-part="${CSS.escape(`role:${executionId}`)}"]`) ??
    (run && (executionId === run.lead || !view?.querySelector('[data-chat-part^="role:"]'))
      ? view
          ?.querySelector(`[data-presence-label="${CSS.escape(`run:${run.runId}`)}"]`)
          ?.closest('[data-chat-item]')
      : null);
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (run) onViewRun?.(run.runId);
}
