import type { Clock, Scheduler } from '@corral/contracts';
import { Coordinator, InProcessTransport, type RuntimeTransport } from '@corral/core';
import { ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';

// The in-browser runtime: the real coordinator with simulated agents (ADR-012, ADR-016).
// Nothing leaves the page. Studio uses the local server instead when it served the page.

const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

const browserTimers: Scheduler = {
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `?delay=<ms>` slows or speeds simulated replies; the default leaves time to steer. */
function replyDelayMs(): number {
  const value = Number(new URLSearchParams(window.location.search).get('delay'));
  return Number.isFinite(value) && value >= 0 && value <= 60_000 ? value || 1500 : 1500;
}

export function createDemoTransport(): RuntimeTransport {
  const ms = replyDelayMs();
  const coordinator = new Coordinator({
    clock: systemClock,
    ids: new SequentialIdFactory(),
    timers: browserTimers,
    agents: new ScriptedAgentAdapter({ turns: 2, beforeReply: () => delay(ms) }),
  });
  return new InProcessTransport(coordinator);
}
