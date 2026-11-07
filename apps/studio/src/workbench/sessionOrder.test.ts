import { describe, expect, it } from 'vitest';
import { bySidebarOrder, sessionJumpTarget } from './sessionOrder.ts';

const session = (sessionId: string, projectId: string, updatedAt: string, pinned = false) => ({
  sessionId,
  projectId,
  updatedAt,
  pinned,
});

const sessions = [
  session('old', 'p1', '2026-11-01T00:00:00Z'),
  session('pinned', 'p1', '2026-10-01T00:00:00Z', true),
  session('new', 'p1', '2026-11-05T00:00:00Z'),
  session('other', 'p2', '2026-11-06T00:00:00Z'),
];

describe('session order shared by the sidebar and Mod+digit', () => {
  it('puts pinned sessions first, then the most recently updated', () => {
    expect([...sessions].sort(bySidebarOrder).map((s) => s.sessionId)).toEqual([
      'pinned',
      'other',
      'new',
      'old',
    ]);
  });

  it('jumps to the Nth session of the current project in that order', () => {
    expect(sessionJumpTarget(sessions, 'p1', 1)?.sessionId).toBe('pinned');
    expect(sessionJumpTarget(sessions, 'p1', 2)?.sessionId).toBe('new');
    expect(sessionJumpTarget(sessions, 'p1', 3)?.sessionId).toBe('old');
  });

  it('never jumps into another project or past the list', () => {
    expect(sessionJumpTarget(sessions, 'p2', 2)).toBeUndefined();
    expect(sessionJumpTarget(sessions, 'p1', 4)).toBeUndefined();
    expect(sessionJumpTarget(sessions, undefined, 1)).toBeUndefined();
  });
});
