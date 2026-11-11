import type { RunEvent } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { applyEvent, emptyProjection } from '../src/index.ts';

// A run limit that pauses for the person (the no-progress pause) names itself on the approval,
// from the `limit.reached` fact the Coordinator commits immediately before it
// (chat-widgets-contract §6.3). Nothing is guessed from the approval's subject.

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, string>;
  }
}

const RECORDED = import.meta.glob('./golden/cr052/no-progress-approval.events.jsonl', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const recorded = () =>
  (Object.values(RECORDED)[0] ?? '')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as RunEvent);

describe('approval for a run limit', () => {
  it('carries the limit reached right before it', () => {
    const events = recorded();
    const projection = events.reduce(applyEvent, emptyProjection(events[0]?.runId ?? 'run'));
    const approval = Object.values(projection.approvals)[0];
    expect(approval?.kind).toBe('user_action');
    expect(approval?.limit).toEqual({ kind: 'no_progress', used: 6, max: 6 });
  });

  it('is not given a limit that came earlier, or to an approval for a tool', () => {
    const events = recorded();
    const at = events.findIndex((event) => event.type === 'limit.reached');
    const limit = events[at];
    const approval = events[at + 1];
    if (!limit || approval?.type !== 'approval.requested') throw new Error('fixture changed');
    // Another fact between the limit and the approval: the approval is about something else.
    const between = {
      ...limit,
      type: 'observation.late',
      eventId: 'evt_between',
      payload: { originalEventType: 'reply', originalRef: null, whyIgnored: 'fixture' },
    } as RunEvent;
    const renumber = (list: RunEvent[]) =>
      list.map((event, index) => ({ ...event, runSeq: index + 1 }));
    const apart = renumber([...events.slice(0, at + 1), between, ...events.slice(at + 1)]);
    const later = apart.reduce(applyEvent, emptyProjection(limit.runId));
    expect(Object.values(later.approvals)[0]?.limit).toBeUndefined();
    const tool = renumber([
      ...events.slice(0, at + 1),
      {
        ...approval,
        payload: {
          ...approval.payload,
          criteriaVersionId: null,
          tool: {
            purpose: 'tool',
            executionId: 'exec_0001',
            attemptNo: 1,
            toolCallId: 'call_0001',
            bodyRef: 'artv_0099',
            fingerprint: 'a'.repeat(64),
            deadline: '2026-10-15T00:05:00.000Z',
          },
        },
      } as RunEvent,
    ]);
    const asked = tool.reduce(applyEvent, emptyProjection(limit.runId));
    expect(Object.values(asked.approvals)[0]?.limit).toBeUndefined();
  });
});
