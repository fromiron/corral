import type { Clock } from '@corral/contracts';
import { Coordinator, InProcessTransport, type RuntimeTransport } from '@corral/core';
import { ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';

// P0 runtime: the real coordinator running in the browser with simulated agents (ADR-012,
// ADR-016). Nothing leaves the page. The local server replaces this in P2 (C-015).

const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
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
    agents: new ScriptedAgentAdapter({ turns: 2, beforeReply: () => delay(ms) }),
  });
  return new InProcessTransport(coordinator);
}
