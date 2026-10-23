import type { WorkspacesApi } from '@corral/client';
import type { TextRange, WorkspaceTarget } from '@corral/contracts';
import { useMemo, useSyncExternalStore } from 'react';
import { documentKey, documentStore } from '../documents/store.ts';
import type { Problem } from '../problems.ts';
import { languageStore } from './store.ts';

export interface LanguageProblem extends Problem {
  target: WorkspaceTarget;
  range: TextRange;
  documentVersion: number | null;
}
const empty = {};
const subscribe = () => () => {};
const snapshot = () => empty;

/** Structured diagnostics retain their own version; they never pass through the log parser. */
export function useLanguageProblems(
  client: Pick<WorkspacesApi, keyof WorkspacesApi> | null | undefined,
  sessionId: string,
) {
  const documents = useMemo(() => (client?.languageState ? documentStore(client) : null), [client]);
  const owner = useMemo(
    () => (client && documents ? languageStore(client, documents) : null),
    [client, documents],
  );
  useSyncExternalStore(owner?.subscribe ?? subscribe, owner?.getState ?? snapshot);
  useSyncExternalStore(documents?.subscribe ?? subscribe, documents?.getState ?? snapshot);
  return Object.values(owner?.getState().copies ?? {}).flatMap((copy) => {
    const state = copy.state;
    const session = state?.session;
    if (!state || state.target.sessionId !== sessionId || session?.state !== 'running') return [];
    return session.diagnostics
      .filter((diagnostic) => diagnostic.diagnostics.length)
      .map((diagnostic) => {
        const entry = documents?.getState().documents[documentKey(state.target, diagnostic.path)];
        return {
          key: `language:${session.generation}:${diagnostic.path}`,
          kind: 'language' as const,
          name:
            state.servers.find((server) => server.id === session.serverId)?.name ??
            session.serverId,
          freshness:
            diagnostic.documentVersion === null
              ? ('unknown' as const)
              : entry && owner?.documentVersion(entry.key) === diagnostic.documentVersion
                ? ('current' as const)
                : ('stale' as const),
          problems: diagnostic.diagnostics.map(
            (problem): LanguageProblem => ({
              target: state.target,
              path: diagnostic.path,
              line: problem.range.start.line + 1,
              column: problem.range.start.character + 1,
              range: {
                startLine: problem.range.start.line + 1,
                startColumn: problem.range.start.character + 1,
                endLine: problem.range.end.line + 1,
                endColumn: problem.range.end.character + 1,
              },
              documentVersion: diagnostic.documentVersion,
              severity:
                problem.severity === 2
                  ? 'warning'
                  : problem.severity === 3
                    ? 'info'
                    : problem.severity === 4
                      ? 'hint'
                      : 'error',
              message: problem.message,
            }),
          ),
        };
      });
  });
}
