import { describe, expect, it } from 'vitest';
import { agentSummary } from './agentSummary.ts';

// UX-07: agents are counted by what they are doing, so a paused run never reads as "working".

describe('agent summary (UX-07)', () => {
  it('[TC-UX-07-H] counts a paused run as paused and waiting, with nobody working', () => {
    expect(agentSummary(['waiting_children', 'paused', 'paused'])).toEqual({
      working: 0,
      groups: [
        ['paused', 2],
        ['waitingChildren', 1],
      ],
    });
  });

  it('[TC-UX-07-H] keeps the working count first and drops empty groups', () => {
    expect(agentSummary(['active', 'active', 'waiting_message', 'ready', 'cancelling'])).toEqual({
      working: 2,
      groups: [
        ['waitingMessage', 1],
        ['starting', 1],
        ['stopping', 1],
      ],
    });
  });

  it('[TC-UX-07-N] ignores executions that have ended', () => {
    expect(agentSummary(['succeeded', 'failed', 'cancelled'])).toEqual({ working: 0, groups: [] });
  });
});
