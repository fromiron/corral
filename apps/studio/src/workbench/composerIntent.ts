import type { SessionIntent } from '@corral/core';

// What a request is (workbench.md). The person chooses between a next request and an
// instruction to a running execution. A next request is not fixed on the draft: sent while the
// session's run is going it waits behind that run (`queue`), sent while nothing runs it starts
// one (`next`); the state at send time decides. Only an instruction is fixed once typing starts:
// its target never changes by itself, and if that target can no longer take it, sending is
// blocked with the reason instead of quietly picking another execution or making it a request.

export interface IntentLock {
  intent: SessionIntent;
  /** The execution an instruction is for; null for other intents. */
  target: string | null;
}

/** Why a fixed instruction cannot be sent: its execution ended, or its whole run did. */
export type Blocked = 'target' | 'run' | null;

/** The two things a person can choose to send. */
export type IntentChoice = 'next' | 'steer';

export function resolveIntent({
  allowed,
  chosen,
  chosenTarget,
  lock,
  targets,
  running,
  waiting,
}: {
  /** Choices possible right now (an instruction only while an execution can take one). */
  allowed: readonly IntentChoice[];
  chosen: SessionIntent | null;
  chosenTarget: string | null;
  /** The fixed instruction; any other stored intent is not a lock. */
  lock: IntentLock | null;
  /** Executions that can take an instruction now. */
  targets: readonly string[];
  /** This session's run is still going (an instruction can still reach it). */
  running: boolean;
  /** A next request sent now waits behind a run that is going. */
  waiting: boolean;
}): { intent: SessionIntent; target: string | null; blocked: Blocked } {
  if (lock?.intent === 'steer') {
    const blocked: Blocked = !running
      ? 'run'
      : lock.target && targets.includes(lock.target)
        ? null
        : 'target';
    return { intent: 'steer', target: lock.target, blocked };
  }
  if (chosen === 'steer' && allowed.includes('steer')) {
    const target =
      chosenTarget && targets.includes(chosenTarget) ? chosenTarget : (targets[0] ?? null);
    return { intent: 'steer', target, blocked: target ? null : 'target' };
  }
  return { intent: waiting ? 'queue' : 'next', target: null, blocked: null };
}

/** The choice an intent stands for: a next request whether it starts now or waits. */
export const intentChoice = (intent: SessionIntent): IntentChoice =>
  intent === 'steer' ? 'steer' : 'next';
