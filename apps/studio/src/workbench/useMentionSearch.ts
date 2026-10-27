import type { FileBrowseScope } from '@corral/client';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { type CorralSummary, type RunSummary, rankFuzzy } from '@corral/core';
import { runResults } from '@corral/react';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { WORKSPACE_CHANGED } from '../pages/FilesViews.tsx';
import { useServices } from '../services.tsx';
import type { MentionItem } from './composerMenu.ts';

// what `@` can point at in a session: files and folders of its working copy (or the
// linked folder before there is one), results of its runs at a fixed version, its runs, and
// the roles of its team. Names only; nothing here reads a file.

export function useMentionSearch({
  projectId,
  sessionId,
  runs,
  team,
}: {
  projectId: string;
  sessionId: string;
  runs: RunSummary[];
  team: CorralSummary | null;
}) {
  const { workspaces, transport, repository } = useServices();
  const ts = useTranslations('Status');
  const tw = useTranslations('Workbench');
  const tr = useTranslations('Results');
  const scope = useRef<Promise<FileBrowseScope | null> | null>(null);
  const results = useRef<{ key: string; items: Promise<MentionItem[]> } | null>(null);
  const roles = useRef<{ key: string; items: Promise<MentionItem[]> } | null>(null);
  useEffect(() => {
    const changed = () => {
      scope.current = null;
    };
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, []);
  // The latest list, read when a search runs; `runsKey` says when cached results are stale.
  const latestRuns = useRef(runs);
  latestRuns.current = runs;
  const runsKey = runs.map((r) => `${r.runId}:${r.status}`).join(',');

  return useCallback(
    async (query: string): Promise<MentionItem[]> => {
      const ordered = [...latestRuns.current];
      const number = (runId: string) => ordered.findIndex((r) => r.runId === runId) + 1;
      const out: MentionItem[] = [];
      if (workspaces) {
        scope.current ??= (async () => {
          const copy = await workspaces.worktree(sessionId).catch(() => null);
          if (copy && !copy.missing && !copy.removedAt) return { kind: 'session', id: sessionId };
          const binding = await workspaces.binding(projectId).catch(() => null);
          return binding && !binding.missing ? { kind: 'project', id: projectId } : null;
        })();
        const where = await scope.current;
        if (where) {
          const found = await workspaces.searchFiles(where, query, 8).catch(() => null);
          for (const item of found?.items ?? [])
            out.push({
              id: `${item.kind}:${item.path}`,
              kind: item.kind,
              label: item.path,
              reference: { kind: item.kind, path: item.path },
            });
        }
      }
      if (results.current?.key !== runsKey)
        results.current = {
          key: runsKey,
          items: (async () => {
            const items: MentionItem[] = [];
            const ended = ordered.filter((r) => TERMINAL_RUN_STATUSES.has(r.status)).reverse();
            for (const run of ended.slice(0, 10)) {
              const [{ projection }, definition] = await Promise.all([
                transport.getSnapshot(run.runId),
                transport.getRunDefinition(run.runId),
              ]);
              const found = runResults(projection);
              for (const artifact of [
                ...found.final,
                ...found.intermediate.map((group) => group.latest),
              ]) {
                const nodeId = projection.executions[artifact.authorExecutionId]?.nodeId;
                const author =
                  definition?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
                items.push({
                  id: `result:${artifact.artifactVersionId}`,
                  kind: 'result',
                  label: `${artifact.name} v${artifact.version}`,
                  detail: [
                    tw('runNumber', { number: number(run.runId) }),
                    author,
                    artifact.authorExecutionNumber
                      ? tr('authorExecution', { number: artifact.authorExecutionNumber })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  reference: {
                    kind: 'result',
                    runId: run.runId,
                    artifactVersionId: artifact.artifactVersionId,
                  },
                });
              }
            }
            return items;
          })().catch(() => []),
        };
      out.push(...rankFuzzy(query, await results.current.items, (i) => i.label, 5));
      const runItems: MentionItem[] = [...ordered].reverse().map((run) => ({
        id: `run:${run.runId}`,
        kind: 'run',
        label: tw('runNumber', { number: number(run.runId) }),
        detail: ts(run.status),
        reference: { kind: 'run', runId: run.runId },
      }));
      out.push(...rankFuzzy(query, runItems, (i) => `${i.label} ${i.detail}`, 4));
      const teamKey = team ? `${team.corralId}:${team.definitionRevision}` : '';
      if (roles.current?.key !== teamKey)
        roles.current = {
          key: teamKey,
          items: team
            ? repository.get(team.corralId).then(
                (record) =>
                  record?.definition.roles.map((role) => ({
                    id: `role:${role.id}`,
                    kind: 'role' as const,
                    label: role.name,
                    detail: role.id,
                    reference: { kind: 'role' as const, roleId: role.id },
                  })) ?? [],
                () => [],
              )
            : Promise.resolve([]),
        };
      out.push(...rankFuzzy(query, await roles.current.items, (i) => `${i.label} ${i.detail}`, 4));
      return out;
    },
    [workspaces, transport, repository, projectId, sessionId, runsKey, team, ts, tw, tr],
  );
}
