type Ordered = { sessionId: string; projectId: string; updatedAt: string; pinned?: boolean };

/** The sidebar's order within a project: pinned first, then the most recently updated. */
export function bySidebarOrder(a: Ordered, b: Ordered): number {
  return (
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt)
  );
}

/** The session Mod+digit opens: the Nth of the current project in sidebar order. */
export function sessionJumpTarget<T extends Ordered>(
  sessions: readonly T[],
  projectId: string | undefined,
  digit: number,
): T | undefined {
  if (!projectId) return undefined;
  return sessions.filter((session) => session.projectId === projectId).sort(bySidebarOrder)[
    digit - 1
  ];
}
