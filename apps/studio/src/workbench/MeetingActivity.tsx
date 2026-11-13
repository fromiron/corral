import type { MeetingView } from '@corral/contracts';
import { ActivityBar, type ActivityBarLine, type ActivityBarRole } from '@corral/react';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { answerLabel, meetingLine, meetingRows } from './meetingActivity.ts';
import { useVisibleLabels } from './session/useActivity.ts';

/** The conversation's timeline this element's composer belongs to. */
const timelineOf = (element: Element | null) =>
  element?.closest('[data-chat-view]')?.querySelector<HTMLElement>('[data-testid="chat-timeline"]');

/** To a row in the timeline, with focus: its first control, else the row itself. */
function goTo(row: Element | null | undefined) {
  if (!(row instanceof HTMLElement)) return;
  row.scrollIntoView({ block: 'nearest' });
  const control = row.querySelector<HTMLElement>('button:not([disabled]), a[href]');
  if (control) {
    control.focus({ preventScroll: true });
    return;
  }
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
}

/**
 * A meeting's activity bar (workbench.md, the meeting's composer): the conversation's bar, told
 * what the meeting does. Closed, the first of a continue card out of view, an answer running out
 * of view, or the last replies at rest, with how many wait their turn; open, a row for each
 * participant answering or waiting, and Stop. A meeting has no join target and no pause.
 */
export function MeetingActivity({
  view,
  name,
  onStop,
  stopping,
}: {
  view: MeetingView;
  /** A participant's, or the secretary's, name. */
  name: (participantId: string) => string;
  /** Stops the replies running and waiting; absent while nothing runs. */
  onStop?: (() => void) | undefined;
  /** A stop is on its way: not pressed again. */
  stopping: boolean;
}) {
  const t = useTranslations('Meetings');
  const ta = useTranslations('Activity');
  const tp = useTranslations('Presence');
  // Answering, or, once its message was stopped and until it ends, stopping (features/presence.md).
  const answeringWord = (stopping: boolean) =>
    stopping ? tp('state.stopping') : t('status.running');
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const visible = useVisibleLabels(anchor);
  // When this page first saw each answer running: its clock (the meeting keeps no start time).
  const seen = useRef(new Map<string, number>());
  const rows = meetingRows(view);
  for (const row of rows)
    if (row.runId && !seen.current.has(row.runId)) seen.current.set(row.runId, Date.now());
  const line = meetingLine(view, { visible, open });
  const revealAnswer = (runId: string) =>
    goTo(
      timelineOf(anchor.current)
        ?.querySelector(`[data-presence-label="${answerLabel(runId)}"]`)
        ?.closest('[data-chat-item]'),
    );
  const revealHold = () => goTo(timelineOf(anchor.current)?.querySelector('[data-meeting-hold]'));
  const waiting = (count: number) =>
    count ? (
      <span className="shrink-0 whitespace-nowrap tabular-nums">
        {t('activity.waiting', { count })}
      </span>
    ) : undefined;

  const said = ((): ActivityBarLine | null => {
    if (!line) return null;
    switch (line.kind) {
      case 'hold':
        return {
          glyph: 'waiting',
          tone: 'warning',
          text: t('hold.heading'),
          parts: waiting(line.waiting),
          action: { label: ta('view'), onClick: revealHold },
        };
      case 'answering':
        return {
          glyph: 'running',
          tone: 'active',
          state: { text: answeringWord(line.stopping), target: answerLabel(line.runId) },
          text: name(line.participantId),
          parts: waiting(line.waiting),
          startedAt: seen.current.get(line.runId),
          action: { label: ta('view'), onClick: () => revealAnswer(line.runId) },
        };
      case 'busy':
        return { glyph: 'running', tone: 'active', parts: waiting(line.waiting) };
      case 'summary': {
        const failed = line.failed ? t('activity.failed', { count: line.failed }) : null;
        if (!line.answered && failed)
          return { glyph: 'failed', tone: 'warning', warning: true, text: failed };
        return {
          glyph: failed ? 'failed' : 'done',
          tone: failed ? 'warning' : 'success',
          text: t('activity.replies', { count: line.answered }),
          ...(failed ? { parts: <span className="shrink-0 text-warning">{failed}</span> } : {}),
        };
      }
    }
  })();

  const roles: ActivityBarRole[] = rows.map((row) => {
    const runId = row.runId;
    const base = {
      id: row.participantId,
      name: name(row.participantId),
      stateShown: true,
      target: false,
    };
    if (runId)
      return {
        ...base,
        glyph: 'running',
        tone: 'active',
        state: { text: answeringWord(row.stopping), target: answerLabel(runId) },
        working: true,
        ...(row.waiting ? { activity: t('activity.moreTurns', { count: row.waiting }) } : {}),
        startedAt: seen.current.get(runId),
        onShow: () => revealAnswer(runId),
      };
    return {
      ...base,
      glyph: 'queued',
      tone: 'neutral',
      state: {
        text:
          row.waiting > 1
            ? t('activity.waitingTurns', { count: row.waiting })
            : t('status.waiting'),
        target: `execution:meeting-wait:${row.participantId}`,
      },
    };
  });

  return (
    <div ref={anchor} data-testid="activity-bar" data-line={line?.kind ?? 'none'}>
      <ActivityBar
        line={said}
        roles={roles}
        controls={
          onStop ? { paused: false, stopDisabled: stopping, disabled: stopping, onStop } : undefined
        }
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
