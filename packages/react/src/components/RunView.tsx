import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  type AgentMark,
  AgentTree,
  type AgentTreeLabels,
  type AgentTreeNode,
  Button,
  fontWeights,
  formatClock,
  Select,
} from '../design-kit/index.ts';
import { useIcon } from '../design-kit/lib/icon-context.tsx';
import type { ModelPrices } from '../run/cost.ts';
import { useRunDisplay } from '../run/display.tsx';
import {
  runFlowExecutionIterationId,
  runFlowExecutionLoopId,
  selectRunFlowIterations,
} from '../run/flow.ts';
import { executionHandoffs } from '../run/handoffs.ts';
import { executionIntervals } from '../run/history.ts';
import type { RunSessionStore, StreamText } from '../run/session.ts';
import { requestOpen } from '../run/transcript.ts';
import { executionAgentStatus, runAgentStatus } from './agentStatus.ts';
import { FailureNotice } from './FailureNotice.tsx';
import { HarnessDetails } from './HarnessDetails.tsx';
import { ReasoningSummary } from './ReasoningSummary.tsx';
import { RunActions } from './RunActions.tsx';
import { RunReason } from './RunText.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';
import { StatusBadge } from './StatusBadge.tsx';
import { UsageInspector } from './UsageInspector.tsx';

/** Run status, executions and output, from committed events only. Needs no editor. */
export function RunView({
  session,
  onSteer,
  onStartFrom,
  prices,
}: {
  session: RunSessionStore;
  onSteer: (executionId: string) => void;
  onStartFrom?: Parameters<typeof RunOutput>[0]['onStartFrom'];
  /** List prices for the cost estimate. */
  prices?: ModelPrices | undefined;
}) {
  const t = useTranslations('Run');
  const projection = useRunDisplay(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  const startError = useStore(session, (s) => s.startError);
  const definitionError = useStore(session, (s) => s.definitionError);
  const streamError = useStore(session, (s) => s.streamError);
  const simulatedHarness = useRunDisplay(session, (s) =>
    s.events.some((event) => event.type === 'harness.simulated'),
  );

  return (
    <div className="flex flex-col gap-3">
      {startError ? (
        <p role="alert" className="text-caption text-danger">
          {t('rejected', { message: startError.message })}
        </p>
      ) : null}
      {definitionError ? (
        <p role="alert" className="text-caption text-warning">
          {t('definitionUnavailable')}{' '}
          <Button
            type="button"
            variant="ghost"
            size="compact"
            onClick={() => {
              const runId = session.getState().runId;
              if (runId) void session.getState().open(runId);
            }}
          >
            {t('retryDefinition')}
          </Button>
        </p>
      ) : null}
      {streamError ? (
        <p role="alert" className="text-caption text-danger">
          {t('streamError', { message: streamError })}
        </p>
      ) : null}
      {projection ? (
        <>
          <RunActions key={projection.runId} session={session} />
          {simulatedHarness ? (
            <p className="text-caption text-muted-foreground">{t('harnessSimulation')}</p>
          ) : null}
          <UsageInspector session={session} prices={prices} />
          <HarnessDetails session={session} />
          <div className="flex items-center gap-2 text-caption">
            <span className="text-muted-foreground">{t('status')}</span>
            <span aria-live="polite" data-testid="run-status">
              <StatusBadge status={projection.status} />
            </span>
          </div>
          {projection.statusReason ? (
            <p className="text-caption text-muted-foreground">
              {t('reasonPrefix')}{' '}
              <RunReason
                code={projection.statusReason}
                nodeLabel={(id) => definition?.nodes.find((n) => n.id === id)?.label ?? id}
              />
            </p>
          ) : null}
          <ExecutionTree session={session} onSteer={onSteer} />
          <RunOutput session={session} {...(onStartFrom ? { onStartFrom } : {})} />
        </>
      ) : null}
    </div>
  );
}

/** The run's final output, once the Output node has it (Markdown, rendered safely). */
export function RunOutput({
  session,
  heading = true,
  onStartFrom,
  onOpenResults,
}: {
  session: RunSessionStore;
  heading?: boolean;
  /** Offers "New run from this result" for the final output. */
  onStartFrom?: (from: { runId: string; artifactVersionId: string; label: string }) => void;
  /** Opens one final result in the Results view. */
  onOpenResults?: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('Run');
  const tr = useTranslations('Results');
  const projection = useRunDisplay(session, (s) => s.projection);
  const finals = (projection?.output?.artifactVersionIds ?? []).flatMap(
    (id) => projection?.artifacts[id] ?? [],
  );
  const loadedOutputText = useStore(session, (s) => s.outputText);
  const runId = useStore(session, (s) => s.runId);
  const resultId = useRunDisplay(
    session,
    (s) => s.projection?.output?.artifactVersionIds[0] ?? null,
  );
  const outputText = resultId ? loadedOutputText : null;
  const result = useRunDisplay(session, (s) =>
    resultId ? s.projection?.artifacts[resultId] : undefined,
  );
  return (
    <div className="flex flex-col gap-1">
      {heading ? (
        <h3 className="text-caption" style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('output')}
        </h3>
      ) : null}
      {onOpenResults && finals.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-caption">
          {finals.length > 1 ? (
            <span className="text-muted-foreground">
              {tr('finalCount', { count: finals.length })}
            </span>
          ) : null}
          {finals.map((artifact) => {
            const label = tr('itemName', { name: artifact.name, version: artifact.version });
            return (
              <Button
                key={artifact.artifactVersionId}
                type="button"
                onClick={() => onOpenResults(artifact.artifactVersionId)}
                aria-label={label}
                variant="tertiary"
                size="compact"
              >
                {label} ↗
              </Button>
            );
          })}
        </div>
      ) : null}
      {outputText === null ? (
        <p className="text-caption text-muted-foreground">{t('outputPending')}</p>
      ) : (
        <div
          data-testid="run-output"
          className={`overflow-auto rounded-md fill-group p-2 ${heading ? 'max-h-64' : ''}`}
        >
          <SafeMarkdown text={outputText} />
        </div>
      )}
      {onStartFrom && runId && result && outputText !== null ? (
        <Button
          type="button"
          onClick={() =>
            onStartFrom({
              runId,
              artifactVersionId: result.artifactVersionId,
              label: `${result.name} v${result.version}`,
            })
          }
          variant="secondary"
          size="compact"
          className="self-start"
        >
          {t('newRunFromResult')}
        </Button>
      ) : null}
    </div>
  );
}

/** The call tree of one run, for pages that lay out the run's parts themselves (Run page). */
/** Kit logo for a provider; unknown providers fall back to initials. */
function providerMark(provider: string | null | undefined): AgentMark | undefined {
  if (!provider) return undefined;
  if (provider.startsWith('anthropic')) return 'claude';
  if (provider.startsWith('openai')) return 'openai';
  if (provider.startsWith('google') || provider.startsWith('gemini')) return 'gemini';
  if (provider.startsWith('mistral')) return 'mistral';
  return undefined;
}

/** The Loop rounds being inspected, shared by every view of one work flow. */
export type RoundInspection = {
  /** Inspected round per Loop node id; a Loop not listed follows its latest round. */
  selected: Readonly<Record<string, string>>;
  /** Inspects a round of a Loop, or follows its latest round again with `null`. */
  choose: (loopId: string, iterationId: string | null) => void;
};

/**
 * A newly selected execution reveals its round once; a round chosen afterwards stays through new
 * events until another execution is selected, and nothing carries over to another Run.
 */
export function useRoundInspection(
  projection: RunProjection | null | undefined,
  selectedExecutionId: string | null,
): RoundInspection {
  const [inspected, setInspected] = useState<{
    runId: string | null;
    rounds: Record<string, { iterationId: string | null; selectedExecutionId: string | null }>;
  }>({ runId: null, rounds: {} });
  const selectedScope =
    projection && selectedExecutionId
      ? runFlowExecutionIterationId(projection, selectedExecutionId)
      : null;
  const selectedLoop = selectedScope ? projection?.iterations[selectedScope]?.loopNodeId : null;
  const runId = projection?.runId ?? null;
  useEffect(() => {
    if (!runId || !selectedScope || !selectedLoop) return;
    setInspected((previous) => ({
      runId,
      rounds: {
        ...(previous.runId === runId ? previous.rounds : {}),
        [selectedLoop]: { iterationId: selectedScope, selectedExecutionId },
      },
    }));
  }, [runId, selectedScope, selectedLoop, selectedExecutionId]);
  const selected = useMemo(() => {
    const rounds: Record<string, string> = {};
    const manual = inspected.runId === runId ? inspected.rounds : {};
    for (const [loopId, choice] of Object.entries(manual))
      if (choice.iterationId) rounds[loopId] = choice.iterationId;
    if (
      selectedScope &&
      selectedLoop &&
      manual[selectedLoop]?.selectedExecutionId !== selectedExecutionId
    )
      rounds[selectedLoop] = selectedScope;
    return rounds;
  }, [inspected, runId, selectedScope, selectedLoop, selectedExecutionId]);
  const choose = useCallback(
    (loopId: string, iterationId: string | null) =>
      setInspected((previous) => ({
        runId,
        rounds: {
          ...(previous.runId === runId ? previous.rounds : {}),
          [loopId]: { iterationId, selectedExecutionId },
        },
      })),
    [runId, selectedExecutionId],
  );
  return { selected, choose };
}

/**
 * The execution tree as the kit's card tree: the run at the root, each execution under the one
 * that started it. Each Loop has one group with only its inspected round's execution cards.
 * Round inspection never changes the current projection or the selected command target.
 */
export function ExecutionTree({
  session,
  onSteer,
  selectedExecutionId = null,
  compact = false,
  wideCards = false,
  now,
  rounds,
}: {
  session: RunSessionStore;
  onSteer: (executionId: string) => void;
  selectedExecutionId?: string | null;
  compact?: boolean;
  /** Cards widen to the room their branches have, for a tree that owns a wide view. */
  wideCards?: boolean;
  /** The inspected rounds when other views of the work flow share them; otherwise its own. */
  rounds?: RoundInspection;
  /** Fixed clock for a past view, ms. Omitted, open spans run to the present. */
  now?: number;
}) {
  const t = useTranslations('Run');
  const tree = useTranslations('Run.tree');
  const loopText = useTranslations('RunLoop');
  const outcomeText = useTranslations('Canvas.nodeStatus.loopOutcome');
  const LoopIcon = useIcon('rotate-ccw');
  const status = useTranslations('Status');
  const projection = useRunDisplay(session, (s) => s.projection);
  const events = useRunDisplay(session, (s) => s.events);
  const definition = useStore(session, (s) => s.definition);
  const streams = useRunDisplay(session, (s) => s.streams);
  const own = useRoundInspection(projection, selectedExecutionId);
  // The tree's own width sets how wide its cards can be.
  const [treeElement, treeRef] = useState<HTMLDivElement | null>(null);
  const [treeWidth, setTreeWidth] = useState(0);
  useLayoutEffect(() => {
    if (!wideCards || !treeElement) return;
    // A scrollbar coming and going must not resize the cards back and forth.
    const measure = () =>
      setTreeWidth((current) =>
        Math.abs(treeElement.clientWidth - current) < 24 ? current : treeElement.clientWidth,
      );
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(treeElement);
    return () => observer.disconnect();
  }, [wideCards, treeElement]);
  const { selected: selectedIterations, choose } = rounds ?? own;
  const intervals = useMemo(
    () => new Map(executionIntervals(events).map((row) => [row.executionId, row])),
    [events],
  );
  const labels = useMemo<Partial<AgentTreeLabels>>(
    () => ({
      agents: (count) => tree('count', { count }),
      running: (count) => tree('running', { count }),
      needsYou: (count) => tree('needsYou', { count }),
      failed: (count) => tree('failed', { count }),
      needsYouList: tree('needsYouList'),
      failedList: tree('failedList'),
      showBranch: (count, name) => tree('showBranch', { count, name }),
      foldBranch: (name) => tree('foldBranch', { name }),
      duration: formatClock,
    }),
    [tree],
  );
  if (!projection) return null;
  const loops = definition
    ? selectRunFlowIterations(projection, definition, selectedIterations, events)
    : [];
  if (projection.executionOrder.length === 0 && loops.length === 0)
    return <p className="text-caption text-muted-foreground">{t('noExecutions')}</p>;
  const loopById = new Map(loops.map((loop) => [loop.nodeId, loop]));
  const loopTreeId = (id: string) => `loop-group-${id}`;
  const treeLoop = new Map(loops.map((loop) => [loopTreeId(loop.nodeId), loop]));
  const nodeDefinition = new Map(definition?.nodes.map((node) => [node.id, node]));
  const iterationOf = new Map(
    projection.executionOrder.map((id) => [id, runFlowExecutionIterationId(projection, id)]),
  );
  const loopOf = new Map(
    projection.executionOrder.map((id) => [
      id,
      definition ? runFlowExecutionLoopId(projection, definition, id) : undefined,
    ]),
  );
  const visible = new Set(
    projection.executionOrder.filter((id) => {
      const loopId = loopOf.get(id);
      const iterationId = iterationOf.get(id);
      return (
        !!projection.executions[id] &&
        (!loopId ||
          !iterationId ||
          !loopById.has(loopId) ||
          loopById.get(loopId)?.selectedIterationId === iterationId)
      );
    }),
  );
  const statusLabel = (value: string) => (status.has(value) ? status(value) : value);
  const labelOf = (nodeId: string) => nodeDefinition.get(nodeId)?.label ?? nodeId;
  const childrenOf = new Map<string | null, string[]>();
  const addChild = (parent: string | null, id: string) => {
    const children = childrenOf.get(parent) ?? [];
    children.push(id);
    childrenOf.set(parent, children);
  };
  const loopParents = new Map<string, Set<string | null>>();
  for (const id of visible) {
    const execution = projection.executions[id];
    if (!execution) continue;
    const parent =
      execution.parentExecutionId && visible.has(execution.parentExecutionId)
        ? execution.parentExecutionId
        : null;
    const loopId = loopOf.get(id);
    if (loopId && loopById.has(loopId) && (!parent || loopOf.get(parent) !== loopId)) {
      addChild(loopTreeId(loopId), id);
      const parents = loopParents.get(loopId) ?? new Set<string | null>();
      parents.add(parent);
      loopParents.set(loopId, parents);
    } else addChild(parent, id);
  }
  for (const loop of loops) {
    const parents = loopParents.get(loop.nodeId);
    addChild(parents?.size === 1 ? ([...parents][0] ?? null) : null, loopTreeId(loop.nodeId));
  }
  const node = (id: string): AgentTreeNode | null => {
    const loop = treeLoop.get(id);
    if (loop) {
      const latest = loop.iterations.find((round) => round.iterationId === loop.latestIterationId);
      const selected = loop.iterations.find(
        (round) => round.iterationId === loop.selectedIterationId,
      );
      const outcome = outcomeText(latest?.outcome ?? 'pending');
      return {
        id,
        name: loopText('title', { name: loop.label }),
        logo: LoopIcon,
        status:
          loop.status === 'active'
            ? 'running'
            : loop.status === 'unrecorded'
              ? 'queued'
              : loop.status === 'cancelled'
                ? 'stopped'
                : 'done',
        statusLabel: outcome,
        task: loopText('summary', { count: loop.iterations.length, max: loop.maxIterations }),
        selectable: false,
        summaryExcluded: true,
        cardProps: { 'data-testid': id, 'data-loop-id': loop.nodeId },
        detail: (
          <div className="flex flex-col gap-2">
            <p className="text-caption text-muted-foreground">
              {latest ? loopText('current', { no: latest.no, outcome }) : loopText('noIterations')}
            </p>
            {loop.iterations.length > 0 ? (
              <Select
                label={loopText('iterationLabel', { name: loop.label })}
                value={selectedIterations[loop.nodeId] ?? 'latest'}
                onValueChange={(iterationId) =>
                  choose(loop.nodeId, iterationId === 'latest' ? null : iterationId)
                }
                size="xs"
                options={[
                  { value: 'latest', label: loopText('latest') },
                  ...(!selected && selectedIterations[loop.nodeId]
                    ? [
                        {
                          value: selectedIterations[loop.nodeId] as string,
                          label: loopText('unavailable'),
                          disabled: true,
                        },
                      ]
                    : []),
                  ...[...loop.iterations].reverse().map((round) => ({
                    value: round.iterationId,
                    label: t('round', { no: round.no }),
                  })),
                ]}
              />
            ) : null}
            {!selected && selectedIterations[loop.nodeId] ? (
              <p role="status" className="text-caption text-muted-foreground">
                {loopText('unavailable')}
              </p>
            ) : null}
            {selected && selected.iterationId !== loop.latestIterationId ? (
              <p className="text-caption text-muted-foreground">
                {loopText('selected', {
                  no: selected.no,
                  outcome: outcomeText(selected.outcome ?? 'pending'),
                })}
              </p>
            ) : null}
          </div>
        ),
        children: (childrenOf.get(id) ?? []).flatMap((child) => node(child) ?? []),
      };
    }
    const execution = projection.executions[id];
    if (!execution) return null;
    const executionLoop = loopById.get(loopOf.get(id) ?? '');
    const priorRound = Boolean(
      executionLoop && iterationOf.get(id) !== executionLoop.latestIterationId,
    );
    const interval = intervals.get(id);
    const model = projection.modelProfiles[execution.modelProfile];
    const round = execution.iterationId ? projection.iterations[execution.iterationId]?.no : null;
    const handoffs = executionHandoffs(projection, id);
    // A card names what its execution made, then where it sits among rounds and attempts.
    const made = handoffs.flatMap((handoff) =>
      handoff.kind === 'artifact' ? [`${handoff.name} v${handoff.version}`] : [],
    );
    const task = [
      made.join(', ') || null,
      execution.item ? t('item', execution.item) : null,
      round ? t('round', { no: round }) : null,
      execution.attemptNo > 1 ? t('attempt', { no: execution.attemptNo }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const sent = handoffs.flatMap((handoff) => {
      const to = handoff.targets.map(labelOf).join(', ');
      if (handoff.kind === 'artifact')
        return to ? [{ id: handoff.id, text: `${handoff.name} v${handoff.version} → ${to}` }] : [];
      return [
        {
          id: handoff.id,
          text: `${tree('question')} → ${to} · ${tree(`questionStatus.${handoff.status}`)}`,
        },
      ];
    });
    const children = (childrenOf.get(id) ?? []).flatMap((child) => node(child) ?? []);
    return {
      id,
      name: labelOf(execution.nodeId),
      model: model?.modelId ?? execution.modelProfile,
      ...(providerMark(model?.provider) ? { logo: providerMark(model?.provider) } : {}),
      status: executionAgentStatus(execution.status),
      statusLabel: statusLabel(execution.status),
      ...(task ? { task } : {}),
      ...(interval ? { startedAt: Date.parse(interval.startedAt) } : {}),
      ...(interval?.finished ? { endedAt: Date.parse(interval.endedAt) } : {}),
      ...(execution.waitingOn
        ? {
            ask: t(`waiting.${execution.waitingOn.kind}`, {
              count: execution.waitingOn.targetIds.length,
            }),
          }
        : {}),
      ...(execution.error ? { error: execution.error } : {}),
      detail: (
        <>
          {sent.length ? (
            <ul aria-label={tree('sent')} className="flex flex-wrap gap-1">
              {sent.map((item) => (
                <li
                  key={item.id}
                  data-handoff
                  className="rounded-md bg-muted px-1.5 text-caption text-muted-foreground"
                >
                  {item.text}
                </li>
              ))}
            </ul>
          ) : null}
          <ExecutionDetail
            id={id}
            projection={projection}
            streams={streams}
            compact={compact || priorRound}
          />
        </>
      ),
      cardProps: {
        id: `execution-${id}`,
        'data-testid': `execution-${id}`,
        'data-execution-id': id,
        'aria-current': id === selectedExecutionId ? 'true' : undefined,
      },
      ...(children.length ? { children } : {}),
    };
  };
  const root: AgentTreeNode = {
    id: projection.runId,
    name: definition?.name ?? projection.runId,
    status: runAgentStatus(projection.status),
    statusLabel: statusLabel(projection.status),
    selectable: false,
    summaryExcluded: true,
    children: (childrenOf.get(null) ?? []).flatMap((id) => node(id) ?? []),
  };
  return (
    <AgentTree
      ref={treeRef}
      root={root}
      title={tree('title')}
      selectedId={selectedExecutionId}
      onSelect={(agent) => onSteer(agent.id)}
      labels={labels}
      size="compact"
      cardWidth={wideCards ? fittedCardWidth(root, treeWidth) : TREE.card}
      // The column shrinks to the panel; cards truncate instead of widening it.
      className="grid-cols-[minmax(0,1fr)]"
      {...(now === undefined ? {} : { now })}
    />
  );
}

/** The kit AgentTree's card width, gap between branches and indent per level. */
const TREE = { card: 216, widest: 320, gap: 8, indent: 32 } as const;

/**
 * Cards as wide as the tree's columns allow, so names read whole on a wide page: the first
 * level's branches share the width, each taking its indents, between the kit's card width and a
 * readable maximum. Too narrow for the kit's width, the tree stacks as before.
 */
function fittedCardWidth(root: AgentTreeNode, width: number): number {
  const depth = (node: AgentTreeNode): number =>
    Math.max(0, ...(node.children ?? []).map((child) => depth(child) + 1));
  const branches = root.children ?? [];
  if (!width || !branches.length) return TREE.card;
  const indents = branches.reduce(
    (sum, branch) => sum + TREE.indent * Math.max(1, depth(branch)),
    0,
  );
  const share = (width - TREE.gap * (branches.length - 1) - indents) / branches.length;
  return Math.round(Math.min(TREE.widest, Math.max(TREE.card, share)));
}

/** What a card adds under its summary: wait targets, the error and a streaming response. */
function ExecutionDetail({
  id,
  projection,
  streams,
  compact,
}: {
  id: string;
  projection: RunProjection;
  streams: Record<string, StreamText>;
  compact: boolean;
}) {
  const t = useTranslations('Run');
  const execution = projection.executions[id];
  if (!execution) return null;
  const done = TERMINAL_EXECUTION_STATUSES.has(execution.status);
  const waiting = execution.waitingOn;
  const openCall = execution.modelCallIds.at(-1);
  const lastResponse = openCall ? streams[openCall] : undefined;
  const live =
    lastResponse?.completed || (!done && openCall && !projection.modelCalls[openCall]?.finished)
      ? lastResponse
      : undefined;
  const call = openCall ? projection.modelCalls[openCall] : undefined;
  if (!waiting && !execution.error && !live && (compact || !call)) return null;
  return (
    <>
      {!compact && call ? (
        <ReasoningSummary call={call} open={requestOpen(projection, call.modelCallId)} />
      ) : null}
      {waiting ? (
        <p className="text-muted-foreground" data-testid="waiting-on">
          {t(`waiting.${waiting.kind}`, { count: waiting.targetIds.length })}:{' '}
          {waiting.targetIds.map((target, i) => (
            <span key={target}>
              {i > 0 ? ', ' : ''}
              {projection.executions[target] ? (
                <a href={`#execution-${target}`} className="font-mono underline">
                  {target}
                </a>
              ) : (
                <span className="font-mono">{target}</span>
              )}
            </span>
          ))}
        </p>
      ) : null}
      {execution.error ? (
        <FailureNotice message={execution.error} cancelled={execution.status === 'cancelled'} />
      ) : null}
      {!compact && live?.completed ? (
        <p className="mt-1" style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('completedResponse')}
        </p>
      ) : null}
      {!compact && live?.text ? (
        <p
          data-testid="live-text"
          aria-live="off"
          className="max-h-24 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-1.5 text-muted-foreground"
        >
          {live.text}
          {live.broken ? ` ${t('streamGap')}` : ''}
        </p>
      ) : null}
    </>
  );
}
