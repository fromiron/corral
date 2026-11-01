import { assignSplit, type Split } from './data.ts';

/** Growing corpora cannot reassign previously exposed groups to another split. */
export function assignGroups(rows: { group: string; fingerprint: string }[]) {
  const parents = new Map<string, string>();
  const find = (g: string): string => {
    const p = parents.get(g);
    if (!p || p === g) return g;
    const root = find(p);
    parents.set(g, root);
    return root;
  };
  const seen = new Map<string, string>();
  for (const row of rows) {
    const previous = seen.get(row.fingerprint);
    if (previous) {
      const a = find(previous),
        b = find(row.group);
      if (a !== b) parents.set(a < b ? b : a, a < b ? a : b);
    }
    seen.set(row.fingerprint, row.group);
  }
  const components = new Map<string, Set<Split>>();
  for (const row of rows) {
    const root = find(row.group);
    const splits = components.get(root) ?? new Set<Split>();
    splits.add(assignSplit(row.group));
    components.set(root, splits);
  }
  return new Map(
    rows.map(({ group }) => {
      const root = find(group),
        splits = components.get(root)!;
      return [group, { group: root, split: splits.size === 1 ? [...splits][0]! : null }] as const;
    }),
  );
}
