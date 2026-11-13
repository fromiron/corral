import { type RunEvent, TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import {
  type InteractionView,
  pendingInteractions,
  type RunProjection,
  type RunSummary,
} from '@corral/core';
import {
  executionPresence,
  type Presence,
  type RunSessionState,
  type RunSessionStore,
  runPresence,
} from '@corral/react';
import { type RefObject, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { useServices } from '../../services.tsx';
import { currentAgentExecutions, toolRows } from '../widgets/selectors.ts';
import { type ChatWidgetModel, useChatWidget } from '../widgets/useChatWidgets.tsx';
import { type TrayPlacement, usePendingTray } from './pendingTrayState.ts';
import { useSessionConnection } from './SessionConnection.tsx';

// What the composer's activity bar says (features/composer-flow.md "활동 바"): the session's
// running run and its roles, what waits on the person, what the conversation already shows, and
// the link to the server. The bar itself (`ActivityBar`) only draws what this decides.

/** A role of the run: one current execution. */
export interface ActivityRole {
  id: string;
  name: string;
  presence: Presence;
  /** What it does now, named as the work log names it; null when no exact step is known. */
  activity: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** The first request waiting on the person. */
export type WaitingItem =
  | {
      kind: 'approval';
      approvalId: string;
      /** What it waits for, in words. */
      subject: string;
      /** Decided by an approve or a deny alone: no route to pick, no limit to weigh. */
      decidable?: boolean;
      executionId?: string;
    }
  | { kind: 'question' | 'extension'; subject: string; executionId?: string };

export interface ActivityInput {
  /** The server link (`lost`), or the run's own record (`record`), when it cannot be read. */
  connection: 'ok' | 'lost' | 'record';
  /** The run the bar speaks of: the running one, else the one the conversation presents. */
  run: {
    runId: string;
    presence: Presence;
    live: boolean;
    /** The execution writing the conversation's answer: the run row speaks for it. */
    lead: string | null;
    /** How many roles the run has. */
    roles: number;
  } | null;
  roles: ActivityRole[];
  /** Requests waiting in the tray over the session's runs, and the running run's first. */
  waiting: { count: number; first: WaitingItem | null };
  tray: TrayPlacement;
  /** `data-presence-label` values on screen in the conversation. */
  visible: ReadonlySet<string>;
  /** The join target, when one is chosen. */
  target: string | null;
}

export type ClosedLine =
  | { kind: 'disconnected'; reason: 'lost' | 'record' }
  | { kind: 'waiting'; count: number; item: WaitingItem | null }
  | { kind: 'role'; role: ActivityRole; others: number }
  | { kind: 'target'; role: ActivityRole; stateShown: boolean }
  | { kind: 'summary'; stateShown: boolean }
  | { kind: 'none' };

const WORKING = new Set<Presence['kind']>(['working', 'starting']);

/** Whether a role's state is on screen: its own row, or the run row for the answering role. */
export function roleSeen(input: Pick<ActivityInput, 'run' | 'visible'>, role: { id: string }) {
  return (
    input.visible.has(`execution:${role.id}`) ||
    Boolean(input.run && role.id === input.run.lead && input.visible.has(`run:${input.run.runId}`))
  );
}

/**
 * The closed line: the first that holds of (1) a waiting request whose card is measured
 * off-screen, (2) a working role whose row is off-screen, (3) the join target's activity and
 * (4) the run's summary. A lost link comes before all of them: what follows may be stale.
 */
export function closedLine(input: ActivityInput): ClosedLine {
  if (input.connection !== 'ok') return { kind: 'disconnected', reason: input.connection };
  // Before the tray is measured it is neither on nor off the screen.
  if (input.tray === 'out-of-view' && input.waiting.count > 0)
    return {
      kind: 'waiting',
      count: input.waiting.count,
      item: input.waiting.count === 1 ? input.waiting.first : null,
    };
  const { run } = input;
  if (!run) return { kind: 'none' };
  if (run.live) {
    const away = input.roles.filter(
      (role) => WORKING.has(role.presence.kind) && !roleSeen(input, role),
    );
    const named = away.find((role) => role.id === input.target) ?? away[0];
    if (named) return { kind: 'role', role: named, others: away.length - 1 };
    const target = input.roles.find((role) => role.id === (input.target ?? run.lead));
    if (target && (target.activity || !roleSeen(input, target)))
      return { kind: 'target', role: target, stateShown: !roleSeen(input, target) };
  }
  return { kind: 'summary', stateShown: !input.visible.has(`run:${run.runId}`) };
}

/**
 * The `data-presence-label` values on screen in the conversation this element is in: one
 * observer on the timeline (features/composer-flow.md "보안·성능·접근성"), with the composer lying
 * over its bottom edge left out, and the labels rows bring as they mount.
 */
export function useVisibleLabels(anchor: RefObject<HTMLElement | null>): ReadonlySet<string> {
  const [key, setKey] = useState('');
  useEffect(() => {
    const view = anchor.current?.closest('[data-chat-view]');
    const timeline = view?.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
    if (!view || !timeline || typeof IntersectionObserver === 'undefined') return;
    const composer = view.querySelector<HTMLElement>('[data-testid="chat-composer"]');
    const seen = new Set<Element>();
    let watched = new WeakSet<Element>();
    let observer: IntersectionObserver | null = null;
    let margin = -1;
    const publish = () => {
      const values = new Set<string>();
      for (const element of seen) {
        const value = element.isConnected ? element.getAttribute('data-presence-label') : null;
        if (value) values.add(value);
        else seen.delete(element);
      }
      setKey([...values].sort().join('\n'));
    };
    const watch = () => {
      for (const element of timeline.querySelectorAll('[data-presence-label]')) {
        if (watched.has(element)) continue;
        watched.add(element);
        observer?.observe(element);
      }
    };
    const build = () => {
      const covered = composer?.dataset.composerSurface === 'floating' ? composer.offsetHeight : 0;
      if (covered === margin) return;
      margin = covered;
      observer?.disconnect();
      seen.clear();
      watched = new WeakSet();
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRect.height > 0) seen.add(entry.target);
            else seen.delete(entry.target);
          }
          publish();
        },
        { root: timeline, rootMargin: `0px 0px -${covered}px 0px` },
      );
      watch();
      publish();
    };
    build();
    const mutations = new MutationObserver(() => {
      watch();
      publish();
    });
    mutations.observe(timeline, { childList: true, subtree: true });
    const resized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(build) : null;
    if (composer) resized?.observe(composer);
    return () => {
      mutations.disconnect();
      resized?.disconnect();
      observer?.disconnect();
    };
  }, [anchor]);
  return useMemo(() => new Set(key ? key.split('\n') : []), [key]);
}

// Read while the session has no run going.
const EMPTY_STORE = createStore(() => ({
  runId: null,
  projection: null,
  definition: null,
  events: [],
  streamError: null,
  missingRunId: null,
})) as unknown as RunSessionStore;

/** When each execution was first and, once it ended, last recorded. */
function executionTimes(events: readonly RunEvent[]) {
  const times = new Map<string, { first: string; last: string }>();
  for (const event of events) {
    const payload = event.payload as { executionId?: unknown };
    const id =
      event.executionId ?? (typeof payload.executionId === 'string' ? payload.executionId : null);
    if (!id) continue;
    const known = times.get(id);
    if (known) known.last = event.recordedAt;
    else times.set(id, { first: event.recordedAt, last: event.recordedAt });
  }
  return times;
}

function rolesOf(
  projection: RunProjection,
  definition: RunSessionState['definition'],
  events: readonly RunEvent[],
  toolName: (name: string) => string,
): ActivityRole[] {
  const times = executionTimes(events);
  const calls = Object.values(projection.toolCalls);
  return currentAgentExecutions(projection).map((execution) => {
    const node = definition?.nodes.find((item) => item.id === execution.nodeId);
    const running = toolRows(
      calls
        .filter((call) => call.executionId === execution.executionId)
        .map((call) => ({
          toolCallId: call.toolCallId,
          name: call.name,
          phase: call.phase ?? call.status,
          effect: call.effectId ? projection.effects[call.effectId]?.outcome : null,
        })),
    )
      .filter((row) => row.tone === 'running')
      .at(-1);
    const time = times.get(execution.executionId);
    const ended = TERMINAL_EXECUTION_STATUSES.has(execution.status);
    return {
      id: execution.executionId,
      name: node?.label ?? execution.nodeId,
      presence: executionPresence({ status: execution.status }),
      activity: running && !ended ? toolName(running.name) : null,
      startedAt: time?.first ?? null,
      endedAt: ended ? (time?.last ?? null) : null,
    };
  });
}

/** How many of the running run's current executions are still open. */
export function useActiveExecutionCount(runId: string | null) {
  const { runFor } = useServices();
  const store = runId ? runFor(runId) : EMPTY_STORE;
  return useStore(store, (state) =>
    runId && state.projection?.runId === runId
      ? currentAgentExecutions(state.projection).filter(
          (execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status),
        ).length
      : 0,
  );
}

export interface Activity {
  input: ActivityInput;
  line: ClosedLine;
  /** The running run's store, when one runs. */
  store: RunSessionStore | null;
  projection: RunProjection | null;
  /** The presented run's widgets: its plan, changes and context. */
  model: ChatWidgetModel | null;
  retry: (() => void) | null;
}

/** Everything the activity bar says, for the session's running run `ownActive`. */
export function useActivity({
  ownActive,
  target,
  anchor,
}: {
  ownActive: RunSummary | null;
  target: string | null;
  anchor: RefObject<HTMLElement | null>;
}): Activity {
  const { runFor } = useServices();
  const tt = useTranslations('Turn');
  const ta = useTranslations('Approvals');
  const tw = useTranslations('Widgets');
  const model = useChatWidget();
  const connection = useSessionConnection();
  const tray = usePendingTray();
  const visible = useVisibleLabels(anchor);
  const runId = ownActive?.runId ?? null;
  // The composer's target list already follows and retains this run's store.
  const store = runId ? runFor(runId) : null;
  const state = useStore(
    store ?? EMPTY_STORE,
    useShallow((value) => ({
      runId: value.runId,
      projection: value.projection,
      definition: value.definition,
      events: value.events,
      failed: Boolean(value.streamError || (runId && value.missingRunId === runId)),
    })),
  );
  const projection =
    runId && state.runId === runId && state.projection?.runId === runId ? state.projection : null;
  const toolName = (name: string) => (tt.has(`tool.${name}`) ? tt(`tool.${name}`) : name);
  const roles = useMemo(
    () =>
      projection
        ? rolesOf(projection, state.definition, state.events, (name) =>
            tt.has(`tool.${name}`) ? tt(`tool.${name}`) : name,
          )
        : [],
    [projection, state.definition, state.events, tt],
  );
  const interactions: InteractionView[] = useMemo(
    () => (projection ? pendingInteractions(state.events, projection) : []),
    [projection, state.events],
  );
  const first = interactions[0];
  const roleName = (id: string | undefined) =>
    roles.length > 1 ? roles.find((role) => role.id === id)?.name : undefined;
  const firstItem = ((): WaitingItem | null => {
    // A run the session has open but not this composer's: what its widgets say waits.
    if (!first)
      return model?.action.needsUser && model.action.summary === 'question'
        ? { kind: 'question', subject: model.questionNotice ?? tw('actionQuestion') }
        : null;
    if (first.kind === 'approval') {
      const { approval } = first;
      const call = approval.tool ? projection?.toolCalls[approval.tool.toolCallId] : undefined;
      const what = approval.tool
        ? call
          ? toolName(call.name)
          : ta(
              approval.tool.purpose === 'lsp'
                ? 'lspHeading'
                : approval.tool.purpose === 'check'
                  ? 'checkHeading'
                  : 'toolHeading',
            )
        : ta(`kind.${approval.kind}`, { step: approval.nodeId ?? '' });
      const who = roleName(approval.tool?.executionId);
      return {
        kind: 'approval',
        approvalId: approval.approvalId,
        subject: who ? `${who}: ${what}` : what,
        decidable: approval.kind !== 'route' && !approval.limit,
        ...(approval.tool ? { executionId: approval.tool.executionId } : {}),
      };
    }
    const executionId = first.event.payload.executionId;
    const what = model?.questionNotice ?? tw('actionQuestion');
    const who = roleName(executionId);
    return { kind: first.kind, subject: who ? `${who}: ${what}` : what, executionId };
  })();
  const presented = model?.runId ?? null;
  const run: ActivityInput['run'] = projection
    ? {
        runId: projection.runId,
        presence: runPresence(
          projection,
          Object.values(projection.executions),
          interactions.map((item, order) => ({
            kind: item.kind === 'approval' ? 'approval' : 'question',
            order,
          })),
        ),
        live: true,
        lead: projection.executionOrder[0] ?? null,
        roles: roles.length,
      }
    : presented && model?.plan.runStatus
      ? {
          runId: presented,
          presence: runPresence(
            { status: model.plan.runStatus as RunProjection['status'] },
            [],
            [],
          ),
          live: false,
          lead: null,
          roles: 0,
        }
      : null;
  const recordLost = runId ? state.failed : model?.readState === 'error';
  const input: ActivityInput = {
    connection: connection?.lost ? 'lost' : recordLost ? 'record' : 'ok',
    run,
    roles,
    waiting: { count: Math.max(tray.waiting, interactions.length), first: firstItem },
    tray: tray.placement,
    visible,
    target,
  };
  const retry = connection?.lost
    ? connection.retry
    : recordLost
      ? runId && store
        ? () => void store.getState().open(runId)
        : (model?.retryRead ?? null)
      : null;
  return {
    input,
    line: closedLine(input),
    store,
    projection,
    model,
    retry,
  };
}
