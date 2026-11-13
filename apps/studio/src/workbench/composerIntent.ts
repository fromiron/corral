import {
  type CorralDefinition,
  TERMINAL_EXECUTION_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import type { ExecutionView, RunProjection, SessionIntent } from '@corral/core';
import { awaitsPerson } from '@corral/react';

// How the composer sends (features/composer-flow.md "전송", "합류 대상"). Nothing running: every
// key starts a new request. A run going: the send key joins the target execution (read at its
// next model request), the interrupt key cuts its streaming response, Alt+Enter queues a next
// request. The target is the execution writing the conversation's answer unless the person
// picks another; a picked target is fixed once there is text, and if it can no longer take the
// instruction, sending is blocked with the reason instead of quietly going elsewhere.

export interface IntentLock {
  intent: SessionIntent;
  /** The execution an instruction is for; null for other intents. */
  target: string | null;
}

/** Why a fixed instruction cannot be sent: its execution ended, or its whole run did. */
export type Blocked = 'target' | 'run' | null;

/** The instruction's delivery (features/reins.md "전달 방식"). */
export type Delivery = 'next_request' | 'interrupt';

/** The four sends: a new request, a join, an interrupt and a next request. */
export type SendKind = 'new' | 'join' | 'interrupt' | 'queue';

/** A send the person picks once: `/steer`, `/interrupt`, `/next` or the send menu. */
export type SendChoice = 'join' | 'interrupt' | 'queue';

/** The composer's three send keys: send, interrupt, and Alt+Enter. */
export type SendKeyRole = 'send' | 'interrupt' | 'queue';

/** The rows of the send table, and a fixed target that cannot take its instruction. */
export type Situation = 'idle' | 'join' | 'joinOnly' | 'awaiting' | 'noTarget' | 'blocked';

/** An execution of the session's run that can take an instruction now. */
export interface SteerTarget {
  id: string;
  /** Its role name; the run position follows when two open executions share a name. */
  label: string;
  /** A response it streams can be cut now. */
  interruptible: boolean;
  /** It waits on the person (an approval or a question); the instruction is read after. */
  awaiting: boolean;
}

const SEND_KEYS: Record<Exclude<Situation, 'blocked'>, Record<SendKeyRole, SendKind>> = {
  idle: { send: 'new', interrupt: 'new', queue: 'new' },
  join: { send: 'join', interrupt: 'interrupt', queue: 'queue' },
  joinOnly: { send: 'join', interrupt: 'join', queue: 'queue' },
  awaiting: { send: 'join', interrupt: 'join', queue: 'queue' },
  noTarget: { send: 'queue', interrupt: 'queue', queue: 'queue' },
};

/** The key each one-time choice stands for. */
export const CHOICE_KEY: Record<SendChoice, SendKeyRole> = {
  join: 'send',
  interrupt: 'interrupt',
  queue: 'queue',
};

export interface ResolvedIntent {
  situation: Situation;
  /** The execution an instruction goes to; null while nothing can take one. */
  target: string | null;
  blocked: Blocked;
  /** What each key sends now. */
  keys: Record<SendKeyRole, SendKind>;
  /** What each key sends before a one-time choice; the send menu's sends follow these. */
  base: Record<SendKeyRole, SendKind>;
}

export function resolveIntent({
  running,
  targets,
  lead,
  chosenTarget,
  lock,
  chosen,
}: {
  /** This session's run is going (an instruction can still reach it). */
  running: boolean;
  /** Executions that can take an instruction now. */
  targets: readonly SteerTarget[];
  /** The execution writing the conversation's answer. */
  lead: string | null;
  /** The target the person picked; not fixed while there is no text. */
  chosenTarget: string | null;
  /** The fixed instruction; any other stored intent is not a lock. */
  lock: IntentLock | null;
  /** A send picked for the next send only. */
  chosen: SendChoice | null;
}): ResolvedIntent {
  const resolved = (
    situation: Situation,
    target: string | null,
    blocked: Blocked,
    base: Record<SendKeyRole, SendKind>,
  ): ResolvedIntent => ({
    situation,
    target,
    blocked,
    base,
    keys: chosen ? { ...base, send: base[CHOICE_KEY[chosen]] } : base,
  });
  const situationOf = (target: SteerTarget): Exclude<Situation, 'blocked' | 'idle' | 'noTarget'> =>
    target.awaiting ? 'awaiting' : target.interruptible ? 'join' : 'joinOnly';

  if (lock?.intent === 'steer') {
    const fixed = running ? targets.find((item) => item.id === lock.target) : undefined;
    if (fixed) {
      const situation = situationOf(fixed);
      return resolved(situation, fixed.id, null, SEND_KEYS[situation]);
    }
    // Blocked: the fixed instruction goes nowhere else. Only an explicit other send leaves it,
    // and with no run going that send is a new request.
    return resolved('blocked', lock.target, running ? 'target' : 'run', {
      send: 'join',
      interrupt: 'join',
      queue: running ? 'queue' : 'new',
    });
  }
  if (!running) return resolved('idle', null, null, SEND_KEYS.idle);
  const target =
    targets.find((item) => item.id === chosenTarget) ??
    targets.find((item) => item.id === lead) ??
    targets[0];
  if (!target) return resolved('noTarget', null, null, SEND_KEYS.noTarget);
  const situation = situationOf(target);
  return resolved(situation, target.id, null, SEND_KEYS[situation]);
}

/** The session entry intent and instruction delivery of a send. */
export function intentOf(
  kind: SendKind,
  /** A run is going in the workspace, so a new request waits behind it. */
  waiting: boolean,
): { intent: SessionIntent; delivery: Delivery | null } {
  if (kind === 'join') return { intent: 'steer', delivery: 'next_request' };
  if (kind === 'interrupt') return { intent: 'steer', delivery: 'interrupt' };
  if (kind === 'queue') return { intent: 'queue', delivery: null };
  return { intent: waiting ? 'queue' : 'next', delivery: null };
}

// An execution waiting on the person reads an instruction after the decision (@corral/react).
export { awaitsPerson };

/** The executions that can take an instruction now, in run order, with their role names. */
function openExecutions(
  projection: RunProjection,
  definition: Pick<CorralDefinition, 'nodes'> | null,
) {
  if (TERMINAL_RUN_STATUSES.has(projection.status) || projection.status === 'cancelling') return [];
  const node = (id: string) => definition?.nodes.find((item) => item.id === id);
  return projection.executionOrder.flatMap((id, index) => {
    const execution = projection.executions[id];
    // An advisor watches the roles and takes no instruction (features/advisor.md).
    if (
      !execution ||
      execution.advisor ||
      TERMINAL_EXECUTION_STATUSES.has(execution.status) ||
      execution.status === 'cancelling'
    )
      return [];
    const step = node(execution.nodeId);
    // A check step calls no model, so no instruction reaches it.
    if (step?.type === 'decision' && step.mode === 'check') return [];
    return [{ id, execution, name: step?.label ?? execution.nodeId, position: index + 1 }];
  });
}

/**
 * The name the send menu gives an execution: its role, and its run position when another
 * execution of that role can take an instruction too. An instruction's meta line names its
 * target the same way, after the execution has ended as well.
 */
export function targetLabel(
  projection: RunProjection,
  definition: Pick<CorralDefinition, 'nodes'> | null,
  executionId: string,
): string {
  const execution = projection.executions[executionId];
  const name =
    definition?.nodes.find((item) => item.id === execution?.nodeId)?.label ??
    execution?.nodeId ??
    executionId;
  const position = projection.executionOrder.indexOf(executionId) + 1;
  const others = openExecutions(projection, definition).filter(
    (item) => item.id !== executionId && item.name === name,
  );
  return others.length > 0 ? `${name} · #${position}` : name;
}

/**
 * The executions of a run that can take an instruction, read from its projection
 * (features/composer-flow.md "계약"), and the one writing the conversation's answer.
 */
export function targetsOf(
  projection: RunProjection,
  definition: Pick<CorralDefinition, 'nodes'> | null,
): { targets: SteerTarget[]; lead: string | null } {
  if (TERMINAL_RUN_STATUSES.has(projection.status) || projection.status === 'cancelling')
    return { targets: [], lead: null };
  const targets = openExecutions(projection, definition).map(({ id, execution }) => {
    const awaiting = awaitsPerson(execution);
    return {
      id,
      label: targetLabel(projection, definition, id),
      // Only a working execution has a response to cut (features/reins.md "전달 방식").
      interruptible: execution.status === 'active' && !awaiting,
      awaiting,
    };
  });
  return { targets, lead: projection.executionOrder[0] ?? null };
}
