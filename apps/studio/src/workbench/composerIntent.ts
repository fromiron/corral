import type { SessionIntent } from '@corral/core';

// UX-01 (CR-011 "never silently changed"): what a request is, and for which execution, is fixed
// once the person starts typing. If the run moves on and that is no longer possible, sending is
// blocked with the reason instead of quietly picking another execution or another intent.

export interface IntentLock {
  intent: SessionIntent;
  /** The execution an instruction is for; null for other intents. */
  target: string | null;
}

export type Blocked = 'target' | 'run' | 'intent' | null;

export function resolveIntent({
  allowed,
  chosen,
  chosenTarget,
  lock,
  targets,
  running,
}: {
  /** Intents possible right now (an instruction only while an execution can take one). */
  allowed: readonly SessionIntent[];
  chosen: SessionIntent | null;
  chosenTarget: string | null;
  lock: IntentLock | null;
  /** Executions that can take an instruction now. */
  targets: readonly string[];
  /** This session's run is still going. */
  running: boolean;
}): { intent: SessionIntent; target: string | null; blocked: Blocked } {
  if (lock) {
    if (lock.intent === 'steer') {
      const blocked: Blocked = !running
        ? 'run'
        : lock.target && targets.includes(lock.target)
          ? null
          : 'target';
      return { intent: 'steer', target: lock.target, blocked };
    }
    return {
      intent: lock.intent,
      target: null,
      blocked: allowed.includes(lock.intent) ? null : 'intent',
    };
  }
  const intent = chosen && allowed.includes(chosen) ? chosen : (allowed[0] as SessionIntent);
  if (intent !== 'steer') return { intent, target: null, blocked: null };
  const target =
    chosenTarget && targets.includes(chosenTarget) ? chosenTarget : (targets[0] ?? null);
  return { intent, target, blocked: target ? null : 'target' };
}
