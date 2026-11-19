import type { CorralDefinition, CorralNode } from '@corral/contracts';
import type { CorralRecord } from '@corral/core';
import { importableAgents, type TeamReference } from '@corral/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServices } from '../services.tsx';

// The other saved teams a team can put in as reference Teams or copy roles from, and the saved
// revisions its reference Teams name, so the editor's compiler checks them as a run would.

const keyOf = (corralId: string, revision: number) => `${corralId}@${revision}`;

type ReferenceRead = CorralDefinition | null | 'failed';

interface ReferenceIssue {
  key: string;
  corralId: string;
  revision: number;
  name: string;
  /** The directly editable reference through which this revision was reached. */
  nodeId: string;
  state: 'loading' | 'failed' | 'missing';
}

function referenceIssues(nodes: readonly CorralNode[], reads: ReadonlyMap<string, ReferenceRead>) {
  const issues: ReferenceIssue[] = [];
  const visited = new Set<string>();
  function visit(nodes: readonly CorralNode[], owner?: string) {
    for (const node of nodes) {
      if (node.type !== 'team' || node.source.kind !== 'reference') continue;
      const { corralId, definitionRevision: revision } = node.source;
      const key = keyOf(corralId, revision);
      if (visited.has(key)) continue;
      visited.add(key);
      const read = reads.get(key);
      const nodeId = owner ?? node.id;
      if (read && read !== 'failed') visit(read.nodes, nodeId);
      else
        issues.push({
          key,
          corralId,
          revision,
          name: node.label,
          nodeId,
          state: read === null ? 'missing' : read === 'failed' ? 'failed' : 'loading',
        });
    }
  }
  visit(nodes);
  return issues;
}

export function useSavedTeams(
  record: Pick<CorralRecord, 'corralId' | 'projectId'>,
  definition: { nodes: readonly CorralNode[] },
): {
  references: TeamReference[];
  issues: ReferenceIssue[];
  retry: () => void;
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
      // Project each saved team into the agents and seat tasks the picker can copy.
      const read = await Promise.all(
        others.map(async (team): Promise<TeamReference> => {
          const saved = await repository.get(team.corralId).catch(() => null);
          return saved
            ? {
                ...team,
                definitionRevision: saved.definitionRevision,
                agents: importableAgents(saved.definition),
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

  // Only follow revisions reachable from this draft. The compiler reports graph cycles itself.
  const [reads, setReads] = useState<ReadonlyMap<string, ReferenceRead>>(() => new Map());
  const issues = useMemo(() => referenceIssues(definition.nodes, reads), [definition.nodes, reads]);
  const wanted = JSON.stringify(
    issues
      .filter((issue) => issue.state === 'loading')
      .map(({ key, corralId, revision }) => [key, corralId, revision]),
  );
  useEffect(() => {
    const missing: [string, string, number][] = JSON.parse(wanted);
    if (!missing.length) return;
    let live = true;
    void Promise.all(
      missing.map(async ([key, corralId, revision]): Promise<[string, ReferenceRead]> => {
        try {
          return [key, await repository.getRevision(corralId, revision)];
        } catch {
          return [key, 'failed'];
        }
      }),
    ).then((found) => {
      if (live) setReads((current) => new Map([...current, ...found]));
    });
    return () => {
      live = false;
    };
  }, [wanted, repository]);
  const retry = () =>
    setReads((current) => {
      const next = new Map(current);
      for (const issue of issues) if (issue.state === 'failed') next.delete(issue.key);
      return next;
    });
  const resolve = useCallback(
    (corralId: string, revision: number) => {
      const value = reads.get(keyOf(corralId, revision));
      return value && value !== 'failed' ? value : undefined;
    },
    [reads],
  );
  return { references, resolve, issues, retry };
}
