import { ApiError } from '@corral/client';
import type { TextAttachment } from '@corral/contracts';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { canReadArtifactBody, type RunSummary, type WorkSession } from '@corral/core';
import { PresenceLabel, runResults } from '@corral/react';
import { Button } from '@corral/react/design-kit';
import { FileText } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Checks } from '../../pages/changes/ReviewPage.tsx';
import { useBinding } from '../../pages/FilesViews.tsx';
import { RunDetail } from '../../pages/run/RunPage.tsx';
import { useServices } from '../../services.tsx';
import type { AttachmentCapture } from '../context/bridge.ts';
import type { SessionSearch } from '../panels/routes.ts';
import { summary } from '../runIdentity.ts';
import { listedRunPresence } from '../sessionList.ts';

// Side panes of a session: the run detail, its results and its checks.

/**
 * A run tab's content (features/session-panel.md): one run's record, which never changes run.
 * The selected tab's views follow the address; an unselected one keeps its own until chosen
 * again.
 */
export function RunPanel({
  runId,
  runs,
  active,
  entries,
  search,
  setSearch,
  operable,
  activeTabbed,
  onOpenRun,
}: {
  runId: string;
  runs: RunSummary[];
  /** The session's run still going, as the composer reads it; null when none goes. */
  active: RunSummary | null;
  /** The session's turns: the request that started a run is its title. */
  entries: WorkSession['entries'];
  /** This tab's own views: the address's while it is selected. */
  search: SessionSearch;
  setSearch: (patch: Partial<SessionSearch>, options?: { replace?: boolean }) => void;
  /**
   * The conversation beside the panel can be operated (beside, closed, withdrawn); false while
   * the panel covers it (maximized, a drawer).
   */
  operable: boolean;
  /** The session's run going has a tab of its own in the strip. */
  activeTabbed: boolean;
  /** Opens (or selects) another run's tab: "현재 실행 보기". */
  onOpenRun: (runId: string) => void;
}) {
  // While a past run shows and another run of the session goes, the header says which, once
  // (features/execution-monitor.md): only over the conversation, which otherwise says it, and
  // only while that run has no tab, whose mark otherwise says it. A run still going is not a
  // past run.
  const shown = runs.find((run) => run.runId === runId);
  const elsewhere =
    !operable &&
    !activeTabbed &&
    active &&
    shown &&
    active.runId !== runId &&
    TERMINAL_RUN_STATUSES.has(shown.status)
      ? active
      : null;
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <RunDetail
          key={runId}
          sessionId={shown?.sessionId ?? null}
          conversationOperable={operable}
          runId={runId}
          request={
            entries.find((entry) => entry.runId === runId && entry.intent !== 'steer')?.text ?? null
          }
          lead={
            elsewhere ? (
              <ActiveRunLine
                run={elsewhere}
                number={runs.findIndex((run) => run.runId === elsewhere.runId) + 1}
                onShowActiveRun={() => onOpenRun(elsewhere.runId)}
              />
            ) : null
          }
          embedded
          search={{
            atSeq: search.atSeq,
            execution: search.execution,
            artifact: search.artifact,
            view: search.view ?? (search.result ? 'results' : 'run'),
            result: search.result,
            // A request to respond goes to the conversation's needed-now tray, never here.
          }}
          setSearch={(patch, options) => setSearch(patch, options)}
        />
      </div>
    </div>
  );
}

/**
 * The session's run going, told above a past run's header: its number, its state, and the way to
 * it. A quiet line, as the header's other one-line states are, not a warning.
 */
function ActiveRunLine({
  run,
  number,
  onShowActiveRun,
}: {
  run: RunSummary;
  number: number;
  onShowActiveRun: () => void;
}) {
  const tw = useTranslations('Workbench');
  const tr = useTranslations('RunPage');
  return (
    <div
      data-testid="run-active-elsewhere"
      className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
    >
      <span className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
        <span className="whitespace-nowrap">{tw('runNumber', { number })}</span>
        <PresenceLabel presence={listedRunPresence(run)} />
      </span>
      <Button variant="tertiary" size="compact" className="shrink-0" onClick={onShowActiveRun}>
        {tr('viewActiveRun')}
      </Button>
    </div>
  );
}

/**
 * Each run's name in the run history: the summary of the request that started it, else the name
 * of the team it ran as, read from its pinned definition (never the team's current revision).
 */
export function useRunNames(runs: readonly RunSummary[], entries: WorkSession['entries']) {
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
  // A pinned definition does not change: each run's is read once while the conversation is open.
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
