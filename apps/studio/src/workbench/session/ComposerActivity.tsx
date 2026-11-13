import type { RunSummary } from '@corral/core';
import {
  ActivityBar,
  type ActivityBarLine,
  type ActivityBarRole,
  type ActivityTarget,
  type Presence,
} from '@corral/react';
import { MetaDot } from '@corral/react/design-kit';
import { type RefObject, useEffect, useRef, useState } from 'react';
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
  viewedLabel,
} from '../widgets/ChatWidgets.tsx';
import { OverviewAccess } from '../widgets/OverviewWidgets.tsx';
import { revealPendingTray, useRespondInConversation, useTrayStore } from './pendingTrayState.ts';
import { useLineHold } from './settle.ts';
import { type ActivityAdvisor, type ActivityRole, roleSeen, useActivity } from './useActivity.ts';

const toMs = (value: string | null | undefined) => (value ? Date.parse(value) : undefined);

/**
 * An advisor's mark (features/advisor.md "보이는 곳"): still while it watches, since watching makes
 * no model request, a resting dot whose shape is not the spinner's; it turns only while it reviews.
 */
const advisorMark = (advisor: ActivityAdvisor) =>
  advisor.review === 'watching'
    ? { glyph: 'queued' as const, tone: 'neutral' as const }
    : { glyph: advisor.presence.glyph, tone: advisor.presence.tone };

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
  revealRun,
  notice = null,
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
  /**
   * Opens a run's record, for a role the conversation has no row for; at an execution, for an
   * advisor (it has no row in the conversation).
   */
  onViewRun?: (runId: string, executionId?: string) => void;
  /**
   * Brings the run's item into the conversation's window when it is outside it; false when the
   * conversation has no item for that run. `null` lets the place go once the row is reached.
   */
  revealRun?: (runId: string | null) => boolean;
  /** What went wrong with a run command just pressed; the line says it where a refusal is said. */
  notice?: string | null;
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
  // Read at the press itself: two presses before the page draws again send one decision.
  const decidingNow = useRef(false);
  // A decision sent from the line and refused: the line says so and leaves the card to answer.
  const [refused, setRefused] = useState<{ approvalId: string; message: string } | null>(null);
  const activity = useActivity({ ownActive, target: target || null, anchor, open });
  const { input, line, model, store, projection } = activity;
  const tray = useTrayStore();
  const respond = useRespondInConversation();
  const run = input.run;
  // A state with no words of its own (one this page does not know) is left unsaid.
  const stateOf = (presence: Presence, of: ActivityTarget) =>
    tp.has(presence.labelKey) ? { text: tp(presence.labelKey), target: of } : undefined;
  const reveal = useReveal(anchor, run, onViewRun, revealRun);
  const many = (run?.roles ?? 0) > 1;
  const showTray = () => (respond ? respond() : revealPendingTray(tray, sessionId));

  // The parts after the words: which ended run this is, the plan's count and its step in
  // progress, the change summary. The counts stay whole; as the line narrows (container queries)
  // the step leaves first, then the change summary's line count, then the run's place.
  const planStatus = model?.runId ? model.plan.status : null;
  // A part says something or is left out: no empty plan, no change summary of nothing.
  const counted =
    planStatus && 'completed' in planStatus && planStatus.total > 0 ? planStatus : null;
  const plan = planStatus && 'plan' in planStatus ? planStatus.plan : null;
  // Collapsed, the line names the step in progress; open, the Todo shows it.
  const step =
    plan && model?.plan.selectedChoice?.live && !open
      ? (plan.items.find((item) => item.status === 'in_progress')?.title ?? null)
      : null;
  const viewed = model?.runId && !run?.live && model.viewed ? viewedLabel(model.viewed, tw) : null;
  const changes = Boolean(
    model?.runId &&
      model.chips.includes('changes') &&
      (model.changesLabel === 'error' || model.changeFiles !== 0),
  );
  const parts =
    viewed || counted || changes ? (
      <>
        {viewed ? (
          // The run's place leaves with the dot after it.
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap @max-2xl/composer-surface:hidden">
            {viewed}
            {counted || changes ? <MetaDot /> : null}
          </span>
        ) : null}
        {counted ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span data-testid="activity-plan" className="shrink-0 whitespace-nowrap tabular-nums">
              {planCount(counted, tw)}
            </span>
            {step ? (
              <span
                data-testid="activity-step"
                className="min-w-0 max-w-64 truncate @max-xl/composer-surface:hidden"
              >
                {step}
              </span>
            ) : null}
          </span>
        ) : null}
        {counted && changes ? <MetaDot /> : null}
        {changes && model ? <ChangesChip model={model} /> : null}
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
    const state =
      stateShown && !doing && !others ? stateOf(role.presence, `execution:${role.id}`) : undefined;
    return {
      glyph: role.presence.glyph,
      tone: role.presence.tone,
      ...(state ? { state } : {}),
      ...(text
        ? { text: others ? `${t('rolesWorking', { count: others + 1 })} · ${text}` : text }
        : {}),
      parts,
      startedAt: toMs(role.startedAt),
    };
  };

  const decide = (approvalId: string, decision: 'approve' | 'reject') => {
    if (!store || decidingNow.current) return;
    decidingNow.current = true;
    setDeciding(true);
    void store
      .getState()
      .resolveApproval(approvalId, decision)
      .then((receipt) => {
        if (receipt?.error) setRefused({ approvalId, message: receipt.error.message });
      })
      // Unconfirmed: the run's store keeps the command and checks it again, never as a new one.
      .catch(() => undefined)
      .finally(() => {
        decidingNow.current = false;
        setDeciding(false);
      });
  };
  // The approval on the line. One that takes another's place waits a moment before a press, and
  // so does the View that comes there before it; the first on the line is taken at once when it is
  // drawn with its buttons, and its buttons coming where View was painted (its own, or a count
  // line's) wait too. The wait counts from the frame that paints them, again each time they come
  // back while it runs, reduced motion or not.
  const lineApproval =
    line.kind === 'waiting' && line.item?.kind === 'approval' ? line.item.approvalId : null;
  const [decisionsShown, setDecisionsShown] = useState(false);
  const settled = !useLineHold({
    approval: lineApproval,
    decide: decisionsShown,
    waiting: line.kind === 'waiting',
  });

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
        const refusal =
          item?.kind === 'approval' && refused?.approvalId === item.approvalId ? refused : null;
        const approval =
          item?.kind === 'approval' &&
          item.decidable &&
          !refusal &&
          projection?.approvals[item.approvalId];
        const tool = approval ? approval.tool : undefined;
        const state =
          run && !input.visible.has(`run:${run.runId}`)
            ? stateOf(run.presence, `run:${run.runId}`)
            : undefined;
        return {
          glyph: 'waiting',
          tone: 'warning',
          ...(state ? { state } : {}),
          // A refused decision says so, as its card does; the card answers it again.
          ...(refusal ? { warning: true } : {}),
          text: refusal
            ? ta('refused', { message: refusal.message })
            : item
              ? item.subject
              : t('waiting', { count: line.count }),
          ...(approval
            ? {
                approval: {
                  subject: item.subject,
                  approveLabel: tool ? ta('approveTool') : ta(`approveAs.${approval.kind}`),
                  denyLabel: tool ? ta('rejectTool') : ta(`rejectAs.${approval.kind}`),
                  onApprove: () => decide(approval.approvalId, 'approve'),
                  onDeny: () => decide(approval.approvalId, 'reject'),
                  disabled: deciding || !settled,
                },
              }
            : {}),
          // The whole request is on its card.
          action: { label: t('view'), onClick: showTray, disabled: !settled },
        };
      }
      case 'role':
        return roleLine(line.role, line.others, true);
      case 'target':
        return roleLine(line.role, 0, line.stateShown);
      case 'advisor':
        // Why the next request has not started: the roles are done, the advisor reviews last.
        return {
          ...advisorMark(line.advisor),
          text: t('finalReview', { name: line.advisor.name }),
          parts,
        };
      case 'summary': {
        if (!run) return null;
        // An advisor's own trouble is said on its row; the widgets leave it out of attention.
        const attention = unansweredAttention(model);
        const state = line.stateShown ? stateOf(run.presence, `run:${run.runId}`) : undefined;
        return {
          glyph: run.presence.glyph,
          tone: run.presence.tone,
          ...(state ? { state } : {}),
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
  const roles: ActivityBarRole[] =
    run?.live && input.roles.length
      ? input.roles.map((role) => {
          const state = stateOf(role.presence, `execution:${role.id}`);
          return {
            id: role.id,
            name: role.name,
            glyph: role.presence.glyph,
            tone: role.presence.tone,
            ...(state ? { state } : {}),
            stateShown: !roleSeen(input, role),
            // The spinner says a role works; any other state is written.
            working: role.presence.kind === 'working',
            ...(role.activity ? { activity: role.activity } : {}),
            startedAt: toMs(role.startedAt),
            target: role.id === target,
            onShow: () => reveal(role.id),
            ...(steerable.has(role.id) ? { onJoin: () => onJoin(role.id) } : {}),
          };
        })
      : [];
  // After the roles, each advisor: watching or reviewing, and how many advice reached their
  // targets. It takes no instruction, and its View opens its execution in the run's record.
  if (run?.live)
    for (const advisor of input.advisors ?? []) {
      const words =
        advisor.review === 'watching'
          ? tp('detail.watching')
          : advisor.review === 'reviewing'
            ? t('reviewing')
            : tp.has(advisor.presence.labelKey)
              ? tp(advisor.presence.labelKey)
              : null;
      roles.push({
        id: advisor.id,
        name: advisor.name,
        ...advisorMark(advisor),
        ...(words ? { state: { text: words, target: `execution:${advisor.id}` } } : {}),
        stateShown: true,
        ...(advisor.delivered
          ? { activity: t('adviceDelivered', { count: advisor.delivered }) }
          : {}),
        startedAt: toMs(advisor.startedAt),
        target: false,
        ...(onViewRun ? { onShow: () => onViewRun(run.runId, advisor.id) } : {}),
      });
    }
  // Open, a role row that writes its state says it: the line does not write the same words again.
  const written = open
    ? new Set(
        roles.flatMap((role) =>
          role.state && role.stateShown && !role.working ? [role.state.text] : [],
        ),
      )
    : null;
  const said = ((): ActivityBarLine | null => {
    if (!closed?.state || !written?.has(closed.state.text)) return closed;
    const { state: _written, ...rest } = closed;
    return rest;
  })();
  const status = projection?.status;
  // One command at a time, as the run record's controls send them.
  const sending = activity.sending;
  return (
    <div
      ref={anchor}
      data-testid="activity-bar"
      data-run={run ? run.presence.kind : 'none'}
      data-live={run?.live ? '' : undefined}
      data-line={line.kind}
    >
      <ActivityBar
        line={
          notice
            ? {
                glyph: said?.glyph ?? 'failed',
                tone: 'warning',
                warning: true,
                ...(said?.state ? { state: said.state } : {}),
                text: notice,
                ...(said?.action ? { action: said.action } : {}),
              }
            : said
        }
        end={model?.runId ? <OverviewAccess /> : undefined}
        roles={roles}
        plan={model?.runId ? <ComposerPlan variant="activity" /> : undefined}
        context={model?.runId ? <ActivityContext model={model} /> : undefined}
        controls={
          ownActive && projection
            ? {
                paused: status === 'paused',
                disabled: status === 'cancelling' || status === 'pausing' || sending,
                // A pausing run can still be stopped.
                stopDisabled: status === 'cancelling' || sending,
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
        announcements={
          <>
            <ActivityAnnouncements model={model} />
            {/* A lost link is said at once; the line itself keeps saying it. */}
            <p role="alert" className="sr-only">
              {line.kind === 'disconnected'
                ? t(line.reason === 'lost' ? 'connectionLost' : 'recordLost')
                : ''}
            </p>
          </>
        }
        open={open}
        onOpenChange={setOpen}
        onDecisionsChange={setDecisionsShown}
      />
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A role's row in the conversation's window: its own, else the run's row where that speaks for it. */
function roleRow(
  view: Element | null | undefined,
  executionId: string,
  run: { runId: string; lead: string | null },
) {
  return (
    view?.querySelector(`[data-chat-part="${CSS.escape(`role:${executionId}`)}"]`) ??
    (executionId === run.lead || !view?.querySelector('[data-chat-part^="role:"]')
      ? view
          ?.querySelector(`[data-presence-label="${CSS.escape(`run:${run.runId}`)}"]`)
          ?.closest('[data-chat-item]')
      : null) ??
    null
  );
}

/** Drawn on the page: not hidden, not inert, with a box. */
const drawn = (element: Element) =>
  element.getClientRects().length > 0 && !element.closest('[inert], [hidden]');

/**
 * Scrolls the row into view and gives it the focus: its first control on the page, else the row
 * itself. A row folded away inside its turn is reached by the conversation item that holds it.
 */
function goTo(found: Element) {
  const folded = !drawn(found) && found.closest('[data-chat-item]');
  const row = folded || found;
  row.scrollIntoView({ block: 'nearest' });
  const control = folded
    ? undefined
    : [row, ...row.querySelectorAll(FOCUSABLE)].find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.matches(FOCUSABLE) && drawn(element),
      );
  control?.focus({ preventScroll: true });
  if (control && document.activeElement === control) return;
  if (row instanceof HTMLElement) {
    row.tabIndex = -1;
    row.focus({ preventScroll: true });
  }
}

const REVEAL_POLL_MS = 50;
const REVEAL_TRIES = 60;

/**
 * "View" on a role row (features/composer-flow.md "활동 바"): to the role's row in the
 * conversation, with focus. A row outside the conversation's window is brought in first, by
 * bringing in its run's item; only a role the conversation has no row for opens its run's record.
 */
function useReveal(
  anchor: RefObject<HTMLElement | null>,
  run: { runId: string; lead: string | null } | null,
  onViewRun?: (runId: string) => void,
  revealRun?: (runId: string | null) => boolean,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (executionId: string) => {
    if (!run) return;
    if (timer.current) clearTimeout(timer.current);
    // The conversation's rows, not the composer's own words about them.
    const view = anchor.current
      ?.closest('[data-chat-view]')
      ?.querySelector('[data-testid="chat-timeline"]');
    const row = roleRow(view, executionId, run);
    if (row) {
      goTo(row);
      return;
    }
    const runLabel = `[data-presence-label="${CSS.escape(`run:${run.runId}`)}"]`;
    // The run's item is in the window with no row for the role, or the conversation has no item
    // for the run: the run's record shows the role.
    if (view?.querySelector(runLabel) || !revealRun?.(run.runId)) {
      onViewRun?.(run.runId);
      return;
    }
    let tries = 0;
    const look = () => {
      timer.current = null;
      const found = roleRow(view, executionId, run);
      // The run's item came in without the role's row, or never came.
      const without = Boolean(view?.querySelector(runLabel)) && tries > 6;
      tries += 1;
      if (found || without || tries >= REVEAL_TRIES) {
        revealRun(null);
        if (found) goTo(found);
        else onViewRun?.(run.runId);
        return;
      }
      timer.current = setTimeout(look, REVEAL_POLL_MS);
    };
    timer.current = setTimeout(look, REVEAL_POLL_MS);
  };
}
