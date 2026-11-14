import type { ExecutionStatus } from '@corral/contracts';
import { executionPresence } from '@corral/react';

// UX-07: what a run's agents are doing, counted by their presence
// (docs/specs/features/presence.md). "Working" means a model or tool is in use right now;
// waiting, paused and stopping agents are counted apart.

export type AgentGroup =
  | 'paused'
  | 'waitingChildren'
  | 'waitingMessage'
  | 'waitingApproval'
  | 'starting'
  | 'stopping';

const ORDER: AgentGroup[] = [
  'paused',
  'waitingApproval',
  'waitingChildren',
  'waitingMessage',
  'starting',
  'stopping',
];

function groupOf(status: ExecutionStatus): AgentGroup | 'working' | null {
  const presence = executionPresence({ status });
  if (presence.need === 'approval') return 'waitingApproval';
  if (presence.detail === 'waiting_agents') return 'waitingChildren';
  if (presence.detail) return 'waitingMessage';
  switch (presence.kind) {
    case 'working':
      return 'working';
    case 'starting':
      return 'starting';
    case 'pausing':
    case 'paused':
      return 'paused';
    case 'stopping':
      return 'stopping';
    default:
      return null;
  }
}

export function agentSummary(statuses: readonly ExecutionStatus[]): {
  working: number;
  groups: [AgentGroup, number][];
} {
  let working = 0;
  const counts = new Map<AgentGroup, number>();
  for (const status of statuses) {
    const group = groupOf(status);
    if (group === 'working') working += 1;
    else if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return {
    working,
    groups: ORDER.flatMap((group) => {
      const count = counts.get(group);
      return count ? [[group, count] as [AgentGroup, number]] : [];
    }),
  };
}
