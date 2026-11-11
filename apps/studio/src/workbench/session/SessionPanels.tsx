import { ApiError } from '@corral/client';
import type { TextAttachment } from '@corral/contracts';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { canReadArtifactBody, type RunSummary, type WorkSession } from '@corral/core';
import { runResults } from '@corral/react';
import { Button, EmptyState } from '@corral/react/design-kit';
import { FileText } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useBinding } from '../../pages/FilesViews.tsx';
import { Checks } from '../../pages/ReviewPage.tsx';
import { RunDetail } from '../../pages/RunPage.tsx';
import { useServices } from '../../services.tsx';
import { RunMenu } from '../Breadcrumbs.tsx';
import type { AttachmentCapture } from '../context/bridge.ts';
import { panelRunId } from '../panelRun.ts';
import type { SessionSearch } from '../panels/routes.ts';
import { summary } from '../runIdentity.ts';
import { TopbarCrumb } from '../TopbarSlot.tsx';

// Side panes of a session: the run detail, its results and its checks.

/** Run detail in the side panel: the chosen run (newest by default) with its own views. */
export function RunPanel({
  runs,
  listed,
  entries,
  search,
  setSearch,
}: {
  runs: RunSummary[];
  /** The run list has answered for the current selection. */
  listed: boolean;
  /** The session's turns: the request that started a run is its title. */
  entries: WorkSession['entries'];
  search: SessionSearch;
  setSearch: (patch: Partial<SessionSearch>, options?: { replace?: boolean }) => void;
}) {
  const tw = useTranslations('Workbench');
  const runId = panelRunId(runs, search.run, listed);
  const names = useRunNames(runs, entries);
  if (!runId)
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="grid justify-items-center gap-3">
          <EmptyState title={tw('noRuns')} />
          <Button variant="secondary" onClick={() => setSearch({ panel: undefined })}>
            {tw('openConversation')}
          </Button>
        </div>
      </div>
    );
  // A fallback run must not inherit the selection made inside the run that has gone.
  const own = search.run === undefined || search.run === runId;
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {search.panel === 'run' ? (
        <TopbarCrumb>
          <span aria-hidden="true" className="text-muted-foreground/50">
            /
          </span>
          <RunMenu
            runs={runs}
            runId={runId}
            names={names}
            onSelect={(value) =>
              setSearch({
                run: value,
                atSeq: undefined,
                execution: undefined,
                artifact: undefined,
                view: undefined,
                result: undefined,
              })
            }
          />
        </TopbarCrumb>
      ) : null}
      <div className="min-h-0 flex-1">
        <RunDetail
          key={runId}
          sessionId={runs.find((run) => run.runId === runId)?.sessionId ?? null}
          runId={runId}
          request={
            entries.find((entry) => entry.runId === runId && entry.intent !== 'steer')?.text ?? null
          }
          embedded
          search={
            own
              ? {
                  atSeq: search.atSeq,
                  execution: search.execution,
                  artifact: search.artifact,
                  view: search.view ?? (search.result ? 'results' : 'run'),
                  result: search.result,
                  respond: search.respond,
                }
              : { view: 'run' }
          }
          setSearch={(patch, options) => setSearch({ run: runId, ...patch }, options)}
        />
      </div>
    </div>
  );
}

/**
 * Each run's name in the run history: the summary of the request that started it, else the name
 * of the team it ran as, read from its pinned definition (never the team's current revision).
 */
function useRunNames(runs: readonly RunSummary[], entries: WorkSession['entries']) {
  const { transport } = useServices();
  const requested = new Map(
    entries.flatMap((entry) =>
      entry.runId && entry.intent !== 'steer' ? [[entry.runId, summary(entry.text)] as const] : [],
    ),
  );
  const missing = runs
    .filter((run) => !requested.get(run.runId))
    .map((run) => run.runId)
    .join(',');
  const [teams, setTeams] = useState<Record<string, string | null>>({});
  // A pinned definition does not change: each run's is read once while the panel is open.
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    mounted.current = true;
    for (const runId of missing ? missing.split(',') : []) {
      if (asked.current.has(runId)) continue;
      asked.current.add(runId);
      void transport.getRunDefinition(runId).then(
        (definition) => {
          if (mounted.current)
            setTeams((known) => ({ ...known, [runId]: summary(definition?.name) }));
        },
        () => {},
      );
    }
  }, [transport, missing]);
  return Object.fromEntries(
    runs.map((run) => [run.runId, requested.get(run.runId) ?? teams[run.runId] ?? null]),
  );
}

/**
 * Results use the same final/partial classification as the conversation. A partial result whose
 * text the run no longer keeps is listed as the run's Results view lists it: named, marked as no
 * longer kept, and not offered to open.
 */
export function ArtifactsPanel({
  runs,
  onOpen,
}: {
  runs: RunSummary[];
  onOpen: (runId: string, artifactVersionId: string) => void;
}) {
  const tw = useTranslations('Workbench');
  const tr = useTranslations('Results');
  const td = useTranslations('Desktop');
  const ta = useTranslations('Artifact');
  const tk = useTranslations('Docking');
  const tv = useTranslations('RunMonitor.resultVersions');
  const { transport } = useServices();
  type Item = {
    runId: string;
    id: string;
    label: string;
    author: string;
    kind: 'final' | 'partial' | 'intermediate';
    /** The run still keeps the text (api-contract.md, 산출물 본문 수명). */
    kept: boolean;
  };
  const [items, setItems] = useState<Item[]>([]);
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const ended = [...runs].reverse().filter((run) => TERMINAL_RUN_STATUSES.has(run.status));
  const key = ended
    .slice(0, count)
    .map((run) => run.runId)
    .join(',');
  useEffect(() => {
    void retry;
    let live = true;
    setLoading(true);
    setFailed(false);
    void (async () => {
      const found: Item[] = [];
      for (const runId of key ? key.split(',') : []) {
        const snapshot = await transport.getSnapshot(runId).catch((failure: unknown) => {
          // a run the server no longer opens (it used Ultra) has no results to list.
          if (failure instanceof ApiError && failure.code === 'TARGET_NOT_FOUND') return null;
          throw failure;
        });
        if (!live) return;
        if (!snapshot) continue;
        const definition = await transport.getRunDefinition(runId);
        if (!live) return;
        const results = runResults(snapshot.projection);
        for (const artifact of [
          ...results.final,
          ...results.intermediate.map((group) => group.latest),
        ]) {
          found.push({
            runId,
            id: artifact.artifactVersionId,
            label: `${artifact.name} v${artifact.version}`,
            author: [
              definition?.nodes.find(
                (node) =>
                  node.id === snapshot.projection.executions[artifact.authorExecutionId]?.nodeId,
              )?.label,
              artifact.authorExecutionNumber
                ? tr('authorExecution', { number: artifact.authorExecutionNumber })
                : null,
            ]
              .filter(Boolean)
              .join(' · '),
            kind: results.final.includes(artifact)
              ? 'final'
              : results.kind === 'partial'
                ? 'partial'
                : 'intermediate',
            kept: canReadArtifactBody(snapshot.projection, artifact.artifactVersionId),
          });
        }
      }
      if (live) setItems(found);
    })()
      .catch(() => {
        if (live) setFailed(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [transport, key, retry, tr]);
  if (loading)
    return (
      <p role="status" className="text-caption text-muted-foreground">
        {ta('loading')}
      </p>
    );
  if (failed)
    return (
      <div role="alert" className="space-y-2 text-caption text-danger">
        <p>{td('resultUnavailable')}</p>
        <Button variant="tertiary" onClick={() => setRetry((value) => value + 1)}>
          {td('retryResult')}
        </Button>
      </div>
    );
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-caption text-muted-foreground">{tw('artifactsEmpty')}</p>
      ) : (
        <ul aria-label={tk('artifacts')} className="flex flex-col gap-0.5">
          {items.map((item) => {
            const source = [
              tw('runNumber', {
                number: runs.findIndex((run) => run.runId === item.runId) + 1,
              }),
              item.author,
            ]
              .filter(Boolean)
              .join(' · ');
            const row = (released: boolean) => (
              <>
                <FileText className="shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{item.label}</span>
                  {/* A released body says so first, so a narrow row never cuts it off. */}
                  <span className="truncate text-micro text-muted-foreground">
                    {released ? `${tv('notKept')} · ${source}` : source}
                  </span>
                </span>
                <span className="shrink-0 text-caption text-muted-foreground">{tr(item.kind)}</span>
              </>
            );
            return (
              <li key={`${item.runId}:${item.id}`}>
                {item.kept || item.kind === 'final' ? (
                  <Button
                    variant="ghost"
                    className="h-auto w-full justify-start gap-2.5 py-1.5 text-left"
                    aria-label={`${tr(item.kind)} ${item.label} · ${source}`}
                    onClick={() => onOpen(item.runId, item.id)}
                  >
                    {row(false)}
                  </Button>
                ) : (
                  <div
                    data-result-released=""
                    className="flex min-h-9 w-full items-center gap-2.5 px-4 py-1.5 text-left text-body text-muted-foreground [&_svg]:size-4"
                  >
                    {row(true)}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {ended.length > count ? (
        <Button variant="ghost" onClick={() => setCount((value) => value + 10)}>
          {td('moreResults', { count: ended.length - count })}
        </Button>
      ) : null}
    </div>
  );
}

/** Checks: the agreed commands and their results, as on the review screen. */
export function ChecksPanel({
  session,
  onAttach,
}: {
  session: WorkSession;
  onAttach: (attachment: TextAttachment, capture: AttachmentCapture) => void;
}) {
  const tw = useTranslations('Workbench');
  const { workspaces } = useServices();
  const { binding } = useBinding(session.projectId);
  if (!workspaces) return <p className="text-caption text-muted-foreground">{tw('serverOnly')}</p>;
  return (
    <>
      <Checks
        sessionId={session.sessionId}
        projectId={session.projectId}
        binding={binding ?? null}
        changed={0}
        onAttach={onAttach}
      />
      <Button
        variant="tertiary"
        className="self-start"
        render={<Link to="/sessions/$sessionId/review" params={{ sessionId: session.sessionId }} />}
      >
        {tw('expandReview')}
      </Button>
    </>
  );
}
