import type { CorralDefinition, CorralNode } from '@corral/contracts';
import type { CorralRecord } from '@corral/core';
import { importableRoles, type TeamReference } from '@corral/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServices } from '../services.tsx';

// The other saved teams a team can put in as reference Teams or copy roles from, and the saved
// revisions its reference Teams name, so the editor's compiler checks them as a run would.

const keyOf = (corralId: string, revision: number) => `${corralId}@${revision}`;

/** The saved revisions a team's reference Teams name, as `corralId@revision`. */
function referencesOf(nodes: readonly CorralNode[]): string[] {
  return nodes.flatMap((node) =>
    node.type === 'team' && node.source.kind === 'reference'
      ? [keyOf(node.source.corralId, node.source.definitionRevision)]
      : [],
  );
}

function parseKey(key: string): [string, number] {
  const at = key.lastIndexOf('@');
  return [key.slice(0, at), Number(key.slice(at + 1))];
}

export function useSavedTeams(
  record: Pick<CorralRecord, 'corralId' | 'projectId'>,
  definition: { nodes: readonly CorralNode[] },
): {
  references: TeamReference[];
  resolve: (corralId: string, definitionRevision: number) => CorralDefinition | undefined;
} {
  const { repository } = useServices();
  const [references, setReferences] = useState<TeamReference[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const all = await repository.list().catch(() => null);
      if (!live) return;
      const others = (all ?? [])
        .filter((c) => c.projectId === record.projectId && c.corralId !== record.corralId)
        .map((c) => ({
          corralId: c.corralId,
          definitionRevision: c.definitionRevision,
          name: c.name,
        }));
      setReferences(others);
      // Each team's saved roles, to copy one onto an agent; reading them changes nothing.
      const read = await Promise.all(
        others.map(async (team): Promise<TeamReference> => {
          const saved = await repository.get(team.corralId).catch(() => null);
          return saved
            ? {
                ...team,
                definitionRevision: saved.definitionRevision,
                // Not the roles its advisors run: those only advise.
                roles: importableRoles(saved.definition),
              }
            : team;
        }),
      );
      if (live) setReferences(read);
    })();
    return () => {
      live = false;
    };
  }, [repository, record.projectId, record.corralId]);

  // Saved revisions never change, so each one is read once; null means it is not there.
  const [loaded, setLoaded] = useState<ReadonlyMap<string, CorralDefinition | null>>(
    () => new Map(),
  );
  const known = useRef(loaded);
  known.current = loaded;
  const wanted = useMemo(() => referencesOf(definition.nodes).join('\n'), [definition.nodes]);
  useEffect(() => {
    const queue = wanted ? wanted.split('\n').filter((key) => !known.current.has(key)) : [];
    if (!queue.length) return;
    let live = true;
    void (async () => {
      const found = new Map<string, CorralDefinition | null>();
      // A referenced team may itself reference others; the compiler expands them all.
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        if (known.current.has(key) || found.has(key)) continue;
        const [corralId, revision] = parseKey(key);
        const saved = await repository.getRevision(corralId, revision).catch(() => null);
        found.set(key, saved);
        if (saved) queue.push(...referencesOf(saved.nodes));
      }
      if (live) setLoaded((current) => new Map([...current, ...found]));
    })();
    return () => {
      live = false;
    };
  }, [repository, wanted]);
  const resolve = useCallback(
    (corralId: string, definitionRevision: number) =>
      loaded.get(keyOf(corralId, definitionRevision)) ?? undefined,
    [loaded],
  );
  return { references, resolve };
}
