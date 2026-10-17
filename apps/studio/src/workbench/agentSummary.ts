// UX-07: what a run's agents are doing, counted by their actual state. "Working" means a model
// or tool is in use right now; waiting, paused and stopping agents are counted apart.

export type AgentGroup =
  | 'paused'
  | 'waitingChildren'
  | 'waitingMessage'
  | 'waitingApproval'
  | 'starting'
  | 'stopping';

const GROUP: Record<string, AgentGroup | 'working' | null> = {
  active: 'working',
  queued: 'starting',
  ready: 'starting',
  waiting_children: 'waitingChildren',
  waiting_message: 'waitingMessage',
  waiting_approval: 'waitingApproval',
  pausing: 'paused',
  paused: 'paused',
  cancelling: 'stopping',
};

const ORDER: AgentGroup[] = [
  'paused',
  'waitingApproval',
  'waitingChildren',
  'waitingMessage',
  'starting',
  'stopping',
];

export function agentSummary(statuses: readonly string[]): {
  working: number;
  groups: [AgentGroup, number][];
} {
  let working = 0;
  const counts = new Map<AgentGroup, number>();
  for (const status of statuses) {
    const group = GROUP[status] ?? null;
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
