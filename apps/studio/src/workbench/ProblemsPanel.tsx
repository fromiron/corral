import { RefreshCw } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { useContext, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { SourceNavigationContext } from './context/SourceAttachments.tsx';
import { documentStore } from './documents/store.ts';
import { type Problem, parseProblems } from './problems.ts';

/** Recent task outputs to read; older tasks stay in the tools pane. */
const TASKS_READ = 5;

type Source = {
  key: string;
  kind: 'check' | 'task';
  name: string;
  /**
   * `stale`: the check ran on an older tree; `configChanged`: under another definition of the
   * check; `unknown`: a task log names no source version, so it is never shown as current.
   */
  freshness: 'current' | 'stale' | 'configChanged' | 'unknown';
  problems: Problem[];
};

/**
 * Locations reported by checks and tasks, inside the session copy only (CR-046 P15). A check
 * result keeps the tree and command it ran with, so a result from either one earlier is marked;
 * a task's output has no version (CR-046 P17).
 */
export function ProblemsPanel({ sessionId }: { sessionId: string }) {
  const t = useTranslations('Problems');
  const { workspaces, mode } = useServices();
  const navigation = useContext(SourceNavigationContext);
  const [sources, setSources] = useState<Source[]>([]);
  const [failed, setFailed] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    void revision;
    if (!workspaces || mode !== 'server') return;
    let live = true;
    const read = async () => {
      try {
        const copy = await workspaces.worktree(sessionId);
        if (!copy || copy.missing) {
          if (live) setSources([]);
          return;
        }
        const [checks, tasks] = await Promise.all([
          workspaces.verifications(sessionId),
          workspaces.tasks
            ? workspaces.tasks(sessionId).then((value) => value.tasks)
            : Promise.resolve([]),
        ]);
        const outputs = await Promise.all(
          tasks.slice(0, TASKS_READ).map((task) =>
            workspaces.taskOutput(sessionId, task.operationId, 0).then(
              (output) => ({ task, text: output.text }),
              () => ({ task, text: '' }),
            ),
          ),
        );
        const sources: Source[] = [
          ...checks.map((check) => ({
            key: `check:${check.verificationId}`,
            kind: 'check' as const,
            name: check.name,
            freshness: check.stale
              ? ('stale' as const)
              : check.configChanged
                ? ('configChanged' as const)
                : ('current' as const),
            problems: parseProblems(check.output),
          })),
          ...outputs.map(({ task, text }) => ({
            key: `task:${task.operationId}`,
            kind: 'task' as const,
            name: task.script,
            freshness: 'unknown' as const,
            problems: parseProblems(text),
          })),
        ].filter((source) => source.problems.length);
        if (!live) return;
        setFailed(false);
        setSources(sources);
      } catch {
        if (live) setFailed(true);
      }
    };
    void read();
    const interval = setInterval(() => void read(), 5000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [workspaces, sessionId, mode, revision]);
  if (mode !== 'server' || !workspaces) return null;
  // The dock shows a document the store holds, so the file is opened there first (as Files does).
  const reveal = async (problem: Problem) => {
    setOpenError(null);
    try {
      const owner = documentStore(workspaces);
      const key = await owner.open(sessionId, problem.path);
      const entry = owner.getState().documents[key];
      if (
        !entry ||
        !navigation?.openDocument(entry.target, entry.path, {
          startLine: problem.line,
          startColumn: problem.column,
          endLine: problem.line,
          endColumn: problem.column,
        })
      )
        setOpenError(t('openFailed', { path: problem.path }));
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <section
      aria-label={t('title')}
      data-testid="problems-panel"
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="flex shrink-0 items-center justify-end border-b border-line px-2 py-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('refresh')}
          onClick={() => refresh((value) => value + 1)}
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {openError ? (
          <p role="alert" className="mb-2 px-1 text-xs text-danger">
            {openError}
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-xs text-danger">
            {t('unavailable')}
          </p>
        ) : sources.length ? (
          sources.map((source) => (
            <section key={source.key} aria-label={source.name} className="mb-3">
              <h3 className="flex items-baseline gap-2 px-1 text-xs font-medium">
                <span className="truncate">{source.name}</span>
                <span className="text-muted">{t(source.kind)}</span>
                {source.freshness === 'stale' || source.freshness === 'configChanged' ? (
                  <span className="text-warning">{t(source.freshness)}</span>
                ) : source.freshness === 'unknown' ? (
                  <span className="text-muted">{t('versionUnknown')}</span>
                ) : null}
              </h3>
              <ul className="mt-1 space-y-0.5">
                {source.problems.map((problem) => {
                  const location = `${problem.path}:${problem.line}:${problem.column}`;
                  return (
                    <li key={`${location}:${problem.message}`}>
                      <button
                        type="button"
                        onClick={() => void reveal(problem)}
                        className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-1 text-left text-xs hover:bg-raised"
                      >
                        <span
                          aria-hidden
                          className={`size-1.5 shrink-0 self-center rounded-full ${problem.severity === 'warning' ? 'bg-warning' : 'bg-danger'}`}
                        />
                        <span className="sr-only">{t(`severity.${problem.severity}`)}</span>
                        <span className="shrink-0 font-mono">{location}</span>
                        {problem.message !== location ? (
                          <span
                            className="min-w-0 flex-1 truncate text-muted"
                            title={problem.message}
                          >
                            {problem.message}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        ) : (
          <p className="px-1 text-xs text-muted">{t('empty')}</p>
        )}
      </div>
    </section>
  );
}
