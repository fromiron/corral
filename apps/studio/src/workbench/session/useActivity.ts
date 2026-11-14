import { type RunEvent, TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import {
  type InteractionView,
  pendingInteractions,
  type RunProjection,
  type RunSummary,
} from '@corral/core';
import {
  agentName,
  callLine,
  executionPresence,
  executionWatching,
  type Presence,
  type RunSessionState,
  type RunSessionStore,
  runPresence,
  toolTarget,
  waitingToolPlan,
} from '@corral/react';
import { type RefObject, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
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

/** A role of the run: one current execution still open. */
export interface ActivityRole {
  id: string;
  /** Its step's name; beside another open one of that name, its place too, as the send menu says. */
  name: string;
  presence: Presence;
  /** What it does now, named as the work log names it; null when no exact step is known. */
  activity: string | null;
  startedAt: string | null;
}

/**
 * An advisor of the run (features/advisor.md "보이는 곳"): it watches the roles and is not one of
 * them, so it takes no instruction and nothing that counts roles counts it.
 */
export interface ActivityAdvisor {
  id: string;
  name: string;
  presence: Presence;
  /** Resting between reviews, or reviewing; null when its state says otherwise (paused, failed). */
  review: 'watching' | 'reviewing' | null;
  /** Its advice that reached their targets; dropped and undelivered advice are not counted. */
  delivered: number;
  startedAt: string | null;
}

/** The first request waiting on the person. */
export type WaitingItem =
  | {
      kind: 'approval';
      approvalId: string;
      /** What it waits for, in words. */
      subject: string;
      /**
       * Decided on the line: the line says all an approve allows (a call with its whole one-line
       * subject, a paused step by its name). Anything else is decided on its card.
       */
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
  /** The run's advisors still watching or reviewing, and those that failed. */
  advisors?: ActivityAdvisor[];
  /**
   * The run's flow has reached its end: no role, task, approval or question is open, so nothing
   * but its advisors' last reviews keeps it going (features/composer-flow.md "활동 바").
   */
  flowEnded?: boolean;
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
  /** The flow has reached its end and an advisor's last review keeps the run open. */
  | { kind: 'advisor'; advisor: ActivityAdvisor }
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
 * off-screen, (2) a working role whose row is off-screen, (3) the join target's activity, (4) an
 * advisor's last review once the flow has reached its end (why the run has not ended) and (5) the
 * run's summary. A pause between steps, or for a person, is no last review. A lost link comes before all of them: what follows may be stale.
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
    // Only a review is a last review: a watching advisor waits for work that will not come, and a
    // failed one holds nothing up (its row says it failed).
    const reviewing = input.flowEnded
      ? input.advisors?.find((advisor) => advisor.review === 'reviewing')
      : undefined;
    if (reviewing) return { kind: 'advisor', advisor: reviewing };
  }
  return { kind: 'summary', stateShown: !input.visible.has(`run:${run.runId}`) };
}

/**
 * The `data-presence-label` values on screen in the conversation this element is in: one
 * observer on the timeline (features/composer-flow.md "보안·성능·접근성"), with the composer lying
 * over its bottom edge left out, and the labels rows bring as they mount. A label that came in the
 * timeline and is not measured yet counts as on screen until the observer says it is not: what
 * comes in view is never pointed at for the frames before its first measure, and what comes out of
 * view is said a few frames late, once. A label not in the timeline at all is not on screen.
 */
export function useVisibleLabels(anchor: RefObject<HTMLElement | null>): ReadonlySet<string> {
  const [key, setKey] = useState('');
  useEffect(() => {
    const view = anchor.current?.closest('[data-chat-view]');
    const timeline = view?.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
    if (!view || !timeline || typeof IntersectionObserver === 'undefined') return;
    const composer = view.querySelector<HTMLElement>('[data-testid="chat-composer"]');
    // Each label element in the timeline and whether it is on screen: measured, or assumed so
    // from the moment it came until its first measure.
    const shown = new Map<Element, boolean>();
    let observer: IntersectionObserver | null = null;
    let margin = -1;
    let published: string | null = null;
    const publish = (now = false) => {
      const values = new Set<string>();
      for (const [element, onScreen] of shown) {
        const value = element.isConnected ? element.getAttribute('data-presence-label') : null;
        if (!value) shown.delete(element);
        else if (onScreen) values.add(value);
      }
      const next = [...values].sort().join('\n');
      if (next === published) return;
      published = next;
      // A label that just came is said before the frame that paints it.
      if (now) flushSync(() => setKey(next));
      else setKey(next);
    };
    const watch = () => {
      for (const element of timeline.querySelectorAll('[data-presence-label]')) {
        if (shown.has(element)) continue;
        shown.set(element, true);
        observer?.observe(element);
      }
    };
    const build = () => {
      const covered = composer?.dataset.composerSurface === 'floating' ? composer.offsetHeight : 0;
      if (covered === margin) return;
      margin = covered;
      observer?.disconnect();
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            if (shown.has(entry.target))
              shown.set(entry.target, entry.isIntersecting && entry.intersectionRect.height > 0);
          publish();
        },
        { root: timeline, rootMargin: `0px 0px -${covered}px 0px` },
      );
      // A new margin measures every label again; until then each keeps what it was.
      for (const element of shown.keys()) observer.observe(element);
      watch();
      publish();
    };
    build();
    const mutations = new MutationObserver(() => {
      watch();
      publish(true);
    });
    mutations.observe(timeline, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-presence-label'],
    });
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

/**
 * What a role is doing, in words (features/presence.md "세부"): its presence detail (waiting for
 * agents, for a reply, watching) or the call it runs with what that call works on, as the work log
 * names it. A bare tool name says nothing, and a call waiting on its approval card is the card's
 * to tell, so neither is an activity. Only open executions are roles: ended rounds do not pile up.
 */
function rolesOf(
  projection: RunProjection,
  definition: RunSessionState['definition'],
  events: readonly RunEvent[],
  toolName: (name: string) => string,
  detailText: (key: NonNullable<Presence['detailKey']>) => string,
): ActivityRole[] {
  const times = executionTimes(events);
  const calls = Object.values(projection.toolCalls);
  const args = new Map<string, Record<string, unknown>>();
  for (const event of events)
    if (event.type === 'tool.requested')
      args.set(event.payload.toolCallId, event.payload.validatedArgs);
  const awaited = new Set(
    Object.values(projection.approvals).flatMap((approval) =>
      approval.status === 'pending' && approval.tool ? [approval.tool.toolCallId] : [],
    ),
  );
  // An advisor is not one of the roles: it has its own row (`advisorsOf`).
  const open = currentAgentExecutions(projection).filter(
    (execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status) && !execution.advisor,
  );
  const nameOf = (execution: (typeof open)[number]) =>
    definition?.nodes.find((item) => item.id === execution.nodeId)?.label ?? execution.nodeId;
  return open.map((execution) => {
    const name = nameOf(execution);
    // Told apart as the send menu tells them: by their place in the run.
    const shared = open.filter((other) => nameOf(other) === name).length > 1;
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
    const presence = executionPresence({ status: execution.status });
    const target =
      running && !awaited.has(running.id) ? toolTarget(args.get(running.id) ?? {}) : null;
    const activity = presence.detailKey
      ? detailText(presence.detailKey)
      : running && target
        ? `${toolName(running.name)} · ${target}`
        : null;
    return {
      id: execution.executionId,
      name: shared
        ? `${name} · #${projection.executionOrder.indexOf(execution.executionId) + 1}`
        : name,
      presence,
      activity,
      startedAt: times.get(execution.executionId)?.first ?? null,
    };
  });
}

/**
 * The run's advisors that watch or review, and those that failed (features/advisor.md "보이는
 * 곳"): an ended advisor has nothing left to say, a failed one says it on its row. Each counts the
 * advice its node gave that reached a target, over its attempts.
 */
function advisorsOf(
  projection: RunProjection,
  definition: RunSessionState['definition'],
  events: readonly RunEvent[],
  advisorWord: string,
): ActivityAdvisor[] {
  const times = executionTimes(events);
  const delivered = new Map<string, number>();
  for (const advice of Object.values(projection.advice ?? {})) {
    const directive = advice.directiveId ? projection.directives[advice.directiveId] : undefined;
    const node = projection.executions[advice.observerExecutionId]?.nodeId;
    if (directive?.status === 'delivered' && node)
      delivered.set(node, (delivered.get(node) ?? 0) + 1);
  }
  return currentAgentExecutions(projection)
    .filter(
      (execution) =>
        execution.advisor &&
        (!TERMINAL_EXECUTION_STATUSES.has(execution.status) || execution.status === 'failed'),
    )
    .map((execution) => {
      const presence = executionPresence({ status: execution.status, observer: true });
      return {
        id: execution.executionId,
        name: agentName(definition, execution.nodeId, advisorWord),
        presence,
        review: executionWatching(execution)
          ? 'watching'
          : presence.kind === 'working' || presence.kind === 'starting'
            ? 'reviewing'
            : null,
        delivered: delivered.get(execution.nodeId) ?? 0,
        startedAt: times.get(execution.executionId)?.first ?? null,
      };
    });
}

/**
 * Whether the run's flow has reached its end: it runs, nothing waits on a person, and no task but
 * an advisor's is open (a task with no execution yet is the flow's next step). The projection
 * records no end of the flow itself; this is what it says of one.
 */
function flowEnded(projection: RunProjection, waiting: number): boolean {
  if (projection.status !== 'running' || waiting > 0) return false;
  const advisors = new Set(
    Object.values(projection.executions).flatMap((execution) =>
      execution.advisor ? [execution.taskId] : [],
    ),
  );
  const openTask = Object.values(projection.tasks).some(
    (task) => !advisors.has(task.taskId) && !ENDED_TASKS.has(task.status),
  );
  const openRole = Object.values(projection.executions).some(
    (execution) => !execution.advisor && !TERMINAL_EXECUTION_STATUSES.has(execution.status),
  );
  return !openTask && !openRole;
}
const ENDED_TASKS = new Set(['completed', 'failed', 'cancelled']);

/**
 * How many of the running run's current executions are still open; null until its record is read.
 * An advisor is not counted: with its last review alone left, Stop stops the run without asking.
 */
export function useActiveExecutionCount(runId: string | null): number | null {
  const { runFor } = useServices();
  const store = runId ? runFor(runId) : EMPTY_STORE;
  return useStore(store, (state) =>
    runId && state.runId === runId && state.projection?.runId === runId
      ? currentAgentExecutions(state.projection).filter(
          (execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status) && !execution.advisor,
        ).length
      : null,
  );
}

/** A command to the run is being sent and has no receipt yet. */
export function useCommandSending(runId: string | null) {
  const { runFor } = useServices();
  const store = runId ? runFor(runId) : EMPTY_STORE;
  return useStore(store, (state) =>
    Boolean(runId && state.runId === runId && (state.pendingCommandIds?.length ?? 0) > 0),
  );
}

export interface Activity {
  input: ActivityInput;
  line: ClosedLine;
  /** The running run's store, when one runs. */
  store: RunSessionStore | null;
  projection: RunProjection | null;
  /** A command to the running run is being sent and has no receipt yet. */
  sending: boolean;
  /** The presented run's widgets: its plan, changes and context. */
  model: ChatWidgetModel | null;
  retry: (() => void) | null;
}

/** Everything the activity bar says, for the session's running run `ownActive`. */
export function useActivity({
  ownActive,
  target,
  anchor,
  open = false,
}: {
  ownActive: RunSummary | null;
  target: string | null;
  anchor: RefObject<HTMLElement | null>;
  /** The panel is open: its role rows say their roles' states. */
  open?: boolean;
}): Activity {
  const { runFor } = useServices();
  const tt = useTranslations('Turn');
  const ta = useTranslations('Approvals');
  const tw = useTranslations('Widgets');
  const tp = useTranslations('Presence');
  const tadv = useTranslations('Advice');
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
      sending: (value.pendingCommandIds?.length ?? 0) > 0,
    })),
  );
  const projection =
    runId && state.runId === runId && state.projection?.runId === runId ? state.projection : null;
  const toolName = (name: string) => (tt.has(`tool.${name}`) ? tt(`tool.${name}`) : name);
  const roles = useMemo(
    () =>
      projection
        ? rolesOf(
            projection,
            state.definition,
            state.events,
            (name) => (tt.has(`tool.${name}`) ? tt(`tool.${name}`) : name),
            (key) => tp(key),
          )
        : [],
    [projection, state.definition, state.events, tt, tp],
  );
  const advisorWord = tadv('advisor');
  const advisors = useMemo(
    () => (projection ? advisorsOf(projection, state.definition, state.events, advisorWord) : []),
    [projection, state.definition, state.events, advisorWord],
  );
  const interactions: InteractionView[] = useMemo(
    () => (projection ? pendingInteractions(state.events, projection) : []),
    [projection, state.events],
  );
  const first = interactions[0];
  // A waiting call is named as its card names it, from the same body read the same way.
  const waitingTool =
    first?.kind === 'approval' && first.approval.tool?.purpose === 'tool'
      ? first.approval.tool
      : null;
  const body = useStore(store ?? EMPTY_STORE, (value) =>
    waitingTool ? value.artifactTexts?.[waitingTool.bodyRef] : undefined,
  );
  const bodyRef = waitingTool?.bodyRef ?? null;
  useEffect(() => {
    if (!store || !bodyRef || body !== undefined) return;
    void Promise.resolve(store.getState().loadArtifact(bodyRef)).catch(() => undefined);
  }, [store, bodyRef, body]);
  const fingerprint = waitingTool?.fingerprint ?? null;
  const call = useMemo(() => {
    if (!fingerprint || body === undefined) return null;
    try {
      return callLine(waitingToolPlan(body, fingerprint), (name) =>
        tt.has(`tool.${name}`) ? tt(`tool.${name}`) : name,
      );
    } catch {
      return null;
    }
  }, [fingerprint, body, tt]);
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
      const named = approval.tool ? projection?.toolCalls[approval.tool.toolCallId] : undefined;
      // A paused step by its name; its id is never said.
      const step =
        approval.kind === 'breakpoint' && approval.nodeId
          ? state.definition?.nodes.find((node) => node.id === approval.nodeId)?.label
          : undefined;
      const what = call
        ? call.text
        : approval.tool
          ? named
            ? toolName(named.name)
            : ta(
                approval.tool.purpose === 'lsp'
                  ? 'lspHeading'
                  : approval.tool.purpose === 'check'
                    ? 'checkHeading'
                    : 'toolHeading',
              )
          : approval.kind === 'breakpoint'
            ? step
              ? ta('kind.breakpoint', { step })
              : tw('actionApproval')
            : ta(`kind.${approval.kind}`, { step: '' });
      const who = roleName(approval.tool?.executionId);
      return {
        kind: 'approval',
        approvalId: approval.approvalId,
        subject: who ? `${who}: ${what}` : what,
        // Decided on the line only when the line says all an approve allows: a call with its
        // whole one-line subject, or a paused step by its name. A final output, a check, a
        // person's decision, a route and a limit (which only a person's decision carries) are
        // decided on their cards.
        decidable: approval.tool
          ? approval.tool.purpose === 'tool' && Boolean(call?.whole)
          : approval.kind === 'breakpoint' && Boolean(step),
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
    advisors,
    flowEnded: projection
      ? flowEnded(projection, Math.max(tray.waiting, interactions.length))
      : false,
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
  // Open, the panel's role rows say their roles' states and activities, so the line does not say
  // them again. The rows themselves still go by what the conversation shows.
  const shown = useMemo(
    () =>
      open && roles.length
        ? new Set([...visible, ...roles.map((role) => `execution:${role.id}`)])
        : visible,
    [open, visible, roles],
  );
  const said = useMemo(
    () => (shown === visible ? roles : roles.map((role) => ({ ...role, activity: null }))),
    [shown, visible, roles],
  );
  return {
    input,
    // Open, the advisors' rows say their reviews: the line does not.
    line: closedLine(open ? { ...input, visible: shown, roles: said, advisors: [] } : input),
    store,
    projection,
    sending: Boolean(runId && state.runId === runId && state.sending),
    model,
    retry,
  };
}
