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
  return familyOrder(sessions.filter((session) => session.projectId === projectId))[digit - 1]
    ?.session;
}

type Linked = Ordered & { parentSessionId?: string | null };
export interface SessionNode<T> {
  session: T;
  children: SessionNode<T>[];
}

export function sessionTree<T extends Linked>(sessions: readonly T[]): SessionNode<T>[] {
  const nodes = new Map(sessions.map((session) => [session.sessionId, { session, children: [] }]));
  const roots: SessionNode<T>[] = [];
  for (const node of nodes.values()) {
    const parent = node.session.parentSessionId
      ? nodes.get(node.session.parentSessionId)
      : undefined;
    (parent && parent !== node ? parent.children : roots).push(node);
  }
  const latest = new Map<SessionNode<T>, string>();
  const latestOf = (node: SessionNode<T>): string => {
    const known = latest.get(node);
    if (known) return known;
    latest.set(node, node.session.updatedAt);
    const value = node.children
      .map(latestOf)
      .reduce((a, b) => (b > a ? b : a), node.session.updatedAt);
    latest.set(node, value);
    return value;
  };
  const order = (list: SessionNode<T>[]) => {
    list.sort(
      (a, b) =>
        Number(Boolean(b.session.pinned)) - Number(Boolean(a.session.pinned)) ||
        latestOf(b).localeCompare(latestOf(a)),
    );
    for (const node of list) order(node.children);
  };
  order(roots);
  return roots;
}

export function familyOrder<T extends Linked>(sessions: readonly T[]) {
  const out: { session: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (node: SessionNode<T>, depth: number) => {
    if (seen.has(node.session.sessionId)) return;
    seen.add(node.session.sessionId);
    out.push({ session: node.session, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of sessionTree(sessions)) walk(root, 0);
  return out;
}
