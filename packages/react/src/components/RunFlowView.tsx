import type { CorralDefinition } from '@corral/contracts';
import { canReadArtifactBody, type RunProjection } from '@corral/core';
import { RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  AgentCard,
  AgentHandoff,
  Button,
  DecisionTree,
  fontWeights,
  type HandoffAgent,
  type HandoffCard,
  Select,
} from '../design-kit/index.ts';
import {
  buildRunFlow,
  type FlowEvidenceRef,
  type RunFlow,
  type RunFlowDecision,
  type RunFlowEdge,
  type RunFlowNode,
  runFlowExecutionIterationId,
} from '../run/flow.ts';
import { executionViewPresence } from '../run/projectionPresence.ts';
import { nodeRunSummary } from '../run/selectors.ts';
import type { RunSessionStore } from '../run/session.ts';
import { PresenceBadge } from './PresenceBadge.tsx';
import { LoopEscalationText } from './RunText.tsx';

/** Only named verification facts cross the host boundary; output text stays in Checks. */
export interface RunFlowCheck {
  id: string;
  name: string;
  state: string;
  verdict?: 'pass' | 'fail' | 'inconclusive' | 'not_evaluated';
  exitCode?: number | null;
  timedOut?: boolean;
}

interface Relationship {
  id: string;
  from: RunFlowNode;
  to: RunFlowNode;
  cards: { id: string; artifact?: RunFlowNode; edges: RunFlowEdge[] }[];
}

/** One observed pair per board: adjacent kit lanes must never imply an arbitrary DAG. */
function relationshipGroups(flow: RunFlow): { groups: Relationship[]; remaining: RunFlowEdge[] } {
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const groups = new Map<string, Relationship>();
  const shown = new Set<string>();
  for (const edge of flow.edges) {
    const source = nodes.get(edge.from),
      target = nodes.get(edge.to);
    if (!source || !target) continue;
    const author =
      source.kind === 'artifact'
        ? flow.edges.find((relation) => relation.kind === 'author' && relation.to === source.id)
        : undefined;
    const from = author ? nodes.get(author.from) : source;
    if (from?.kind !== 'agent' || target.kind !== 'agent' || from.id === target.id) continue;
    if (!['read', 'input', 'question', 'answer', 'delegate'].includes(edge.kind)) continue;
    const id = `${from.id}:${target.id}`;
    const group = groups.get(id) ?? { id, from, to: target, cards: [] };
    const cardId = source.kind === 'artifact' ? source.id : edge.kind;
    let card = group.cards.find((candidate) => candidate.id === cardId);
    if (!card) {
      card = { id: cardId, ...(source.kind === 'artifact' ? { artifact: source } : {}), edges: [] };
      group.cards.push(card);
    }
    card.edges.push(edge);
    groups.set(id, group);
    shown.add(edge.id);
  }
  return {
    groups: [...groups.values()],
    remaining: flow.edges.filter(
      (edge) =>
        !shown.has(edge.id) &&
        !['author', 'output', 'branch'].includes(edge.kind) &&
        nodes.get(edge.to)?.kind !== 'decision',
    ),
  };
}

/** Current observed relationships; no body lookup or historical projection is used here. */
export function RunFlowView({
  session,
  definition,
  onSelectExecution,
  onOpenArtifact,
  checks = [],
  selectedExecutionId = null,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  onSelectExecution: (id: string) => void;
  onOpenArtifact: (id: string) => void;
  checks?: readonly RunFlowCheck[];
  selectedExecutionId?: string | null;
}) {
  const t = useTranslations('RunFlow');
  const status = useTranslations('Canvas.nodeStatus');
  const loopText = useTranslations('RunLoop');
  const roundText = useTranslations('Run');
  const projection = useStore(session, (s) => s.projection);
  const events = useStore(session, (s) => s.events);
  const [roundChoices, setRoundChoices] = useState<{
    runId: string | null;
    owner: string | null;
    values: Record<string, string>;
  }>({ runId: null, owner: null, values: {} });
  const linkedIterationId = selectedExecutionId
    ? runFlowExecutionIterationId(projection, selectedExecutionId)
    : null;
  const linkedLoopId = linkedIterationId
    ? projection?.iterations[linkedIterationId]?.loopNodeId
    : null;
  const selectedIterations = useMemo(() => {
    const sameRun = roundChoices.runId === projection?.runId;
    const base = sameRun ? roundChoices.values : {};
    // A newly selected execution reveals its round once. Explicit round browsing afterwards
    // must not keep snapping back to an unchanged execution deep link.
    return (!sameRun || roundChoices.owner !== selectedExecutionId) &&
      linkedLoopId &&
      linkedIterationId
      ? { ...base, [linkedLoopId]: linkedIterationId }
      : base;
  }, [roundChoices, projection?.runId, selectedExecutionId, linkedLoopId, linkedIterationId]);
  const flow = useMemo(
    () => buildRunFlow(projection, events, definition, selectedIterations),
    [projection, events, definition, selectedIterations],
  );
  const { groups, remaining } = useMemo(() => relationshipGroups(flow), [flow]);
  const [selected, setSelected] = useState<string | null>(null);
  const group = groups.find((entry) => entry.id === selected) ?? groups[0];
  // An artifact already shown as a relationship card is not listed a second time below.
  const relayed = new Set(groups.flatMap((entry) => entry.cards.map((card) => card.artifact?.id)));
  const artifacts = flow.nodes.filter((node) => node.kind === 'artifact' && !relayed.has(node.id));
  const agents = flow.nodes.filter((node) => node.kind === 'agent');
  if (!projection) return null;
  const stateLabel = (value: string) => (status.has(value) ? status(value) : t('unrecorded'));
  const asAgent = (node: RunFlowNode): HandoffAgent => {
    const execution = projection.executions[node.executionIds.at(-1) ?? ''];
    const summary = node.nodeId ? nodeRunSummary(projection, node.nodeId) : null;
    const description = summary
      ? [
          ...Object.entries(summary.counts).map(([value, count]) =>
            status('stateCount', { status: stateLabel(value), count: count ?? 0 }),
          ),
          ...(summary.previousFailures
            ? [status('previousFailures', { count: summary.previousFailures })]
            : []),
        ].join(' · ')
      : undefined;
    return {
      id: node.id,
      name: node.label,
      ...(execution ? { model: execution.modelProfile } : {}),
      working: ['active', 'model', 'tool', 'finalizing'].includes(node.status),
      statusLabel: stateLabel(node.status),
      selectable: node.executionIds.length > 0,
      description,
      idleLabel: node.executionIds.length
        ? t('executionCount', { count: node.executionIds.length })
        : t('unrecorded'),
      ...(['active', 'model', 'tool', 'finalizing'].includes(node.status)
        ? { task: { title: stateLabel(node.status) } }
        : {}),
    };
  };
  const cards: HandoffCard[] =
    group?.cards.map((card) => ({
      id: card.id,
      title: card.artifact?.label ?? t(`relation.${card.edges[0]?.kind ?? 'delegate'}`),
      status: 'done',
      stateLabel: t('observed'),
      items: [
        ...card.edges.map((edge) => ({
          id: edge.id,
          label: t(`relation.${edge.kind}`),
          kind: 'link' as const,
        })),
        ...(!card.artifact
          ? [...new Set(card.edges.flatMap((edge) => edge.artifactVersionIds))].map((id) => ({
              id: `attachment:${id}`,
              label: t('attached', { name: projection.artifacts[id]?.name ?? id }),
              kind: 'file' as const,
            }))
          : []),
      ],
      detail: (
        <div className="grid gap-2 text-caption text-muted-foreground">
          {card.artifact && <span>{t('createdBy', { name: group.from.label })}</span>}
          <ObservedTime value={card.artifact?.recordedAt ?? card.edges[0]?.recordedAt ?? null} />
          {card.artifact?.current && card.artifact.artifactVersionId ? (
            <Button
              variant="tertiary"
              onClick={() => onOpenArtifact(card.artifact?.artifactVersionId ?? '')}
            >
              {t('open', { name: card.artifact.label })}
            </Button>
          ) : card.artifact ? (
            <span>{t('metadataOnly')}</span>
          ) : null}
        </div>
      ),
    })) ?? [];

  return (
    // Named by the tab that shows it; no heading of its own.
    <div data-testid="run-flow" className="mx-auto grid w-full max-w-5xl gap-6 pb-6">
      {flow.loops.length > 0 && (
        <div className="grid gap-3">
          {flow.loops.map((loop) => {
            const latest = loop.iterations.find(
              (iteration) => iteration.iterationId === loop.latestIterationId,
            );
            const chosen = loop.iterations.find(
              (iteration) => iteration.iterationId === loop.selectedIterationId,
            );
            const explicit = selectedIterations[loop.nodeId];
            return (
              <AgentCard key={loop.nodeId} data-testid="run-flow-loop" className="grid gap-3 p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <h3
                      className="flex items-center gap-2 text-subtitle"
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      <RotateCcw size={16} aria-hidden />
                      {loopText('title', { name: loop.label })}
                    </h3>
                    <p className="text-caption text-muted-foreground">
                      {loop.maxIterations === null
                        ? loopText('summaryUnlimited', { count: loop.rounds })
                        : loopText('summary', {
                            count: loop.rounds,
                            max: loop.maxIterations,
                          })}
                    </p>
                    {loop.escalation ? (
                      <p className="text-caption" data-testid="run-flow-loop-escalation">
                        <LoopEscalationText
                          escalation={loop.escalation}
                          modelName={(profile) =>
                            projection.modelProfiles[profile]?.modelId ?? profile
                          }
                        />
                      </p>
                    ) : null}
                    <p className="text-caption">
                      {latest
                        ? loopText('current', {
                            no: latest.no,
                            outcome: status(`loopOutcome.${latest.outcome ?? 'pending'}`),
                          })
                        : loopText('noIterations')}
                    </p>
                  </div>
                  <Select
                    label={loopText('iterationLabel', { name: loop.label })}
                    value={explicit ?? '__latest__'}
                    disabled={!loop.iterations.length}
                    options={[
                      { value: '__latest__', label: loopText('latest') },
                      ...loop.iterations.toReversed().map((iteration) => ({
                        value: iteration.iterationId,
                        label: roundText('round', { no: iteration.no }),
                      })),
                      ...(explicit && !chosen
                        ? [{ value: explicit, label: loopText('unavailable') }]
                        : []),
                    ]}
                    onValueChange={(value) => {
                      const values = { ...selectedIterations };
                      if (value === '__latest__') delete values[loop.nodeId];
                      else values[loop.nodeId] = value;
                      setRoundChoices({
                        runId: projection.runId,
                        owner: selectedExecutionId,
                        values,
                      });
                    }}
                  />
                </div>
                {explicit && (
                  <p className="text-caption text-muted-foreground">
                    {chosen
                      ? loopText('selected', {
                          no: chosen.no,
                          outcome: status(`loopOutcome.${chosen.outcome ?? 'pending'}`),
                        })
                      : loopText('unavailable')}
                  </p>
                )}
              </AgentCard>
            );
          })}
        </div>
      )}
      {group ? (
        <section aria-label={t('relationships')} className="grid gap-4">
          {groups.length > 1 && (
            <nav aria-label={t('chooseRelationship')} className="flex flex-wrap gap-1.5">
              {groups.map((entry) => (
                <Button
                  key={entry.id}
                  variant="tertiary"
                  aria-pressed={entry.id === group.id}
                  onClick={() => setSelected(entry.id)}
                >
                  {entry.from.label} → {entry.to.label}
                </Button>
              ))}
            </nav>
          )}
          <AgentHandoff
            key={group.id}
            agents={[asAgent(group.from), asAgent(group.to)]}
            lanes={[
              {
                from: group.from.id,
                to: group.to.id,
                cards,
                passed: true,
                label: t('relationship', { from: group.from.label, to: group.to.label }),
              },
            ]}
            defaultExpandedCardId={cards[0] ? `0:${cards[0].id}` : null}
            onAgentSelect={(id) => {
              const execution = agents.find((node) => node.id === id)?.executionIds.at(-1);
              if (execution) onSelectExecution(execution);
            }}
            emptyLaneLabel={t('noRelationships')}
            labels={{
              working: stateLabel('active'),
              idle: t('unrecorded'),
              upNext: t('upNext'),
              ready: t('unrecorded'),
            }}
          />
          {[group.from, group.to].some((node) => node.executionIds.length > 1) && (
            <div className="flex flex-wrap gap-1.5">
              {[group.from, group.to].flatMap((node) =>
                node.executionIds.map((id) => (
                  <Button key={id} variant="ghost" onClick={() => onSelectExecution(id)}>
                    {t('attempt', {
                      name: node.label,
                      attempt: projection.executions[id]?.attemptNo ?? 1,
                    })}
                  </Button>
                )),
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="grid gap-3" aria-label={t('relationships')}>
          <p className="text-body text-muted-foreground">{t('noRelationships')}</p>
          <div className="flex flex-wrap gap-2">
            {agents.flatMap((node) =>
              node.executionIds.map((id) => (
                <Button key={id} variant="tertiary" onClick={() => onSelectExecution(id)}>
                  {t('attempt', {
                    name: node.label,
                    attempt: projection.executions[id]?.attemptNo ?? 1,
                  })}
                  {projection.executions[id] ? (
                    <PresenceBadge presence={executionViewPresence(projection.executions[id])} />
                  ) : null}
                </Button>
              )),
            )}
          </div>
        </section>
      )}
      {flow.decisions.length > 0 && (
        <section className="grid gap-4" aria-label={t('decisions')}>
          <h3 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
            {t('decisions')}
          </h3>
          {flow.decisions.map((decision) => (
            <DecisionDetail
              key={decision.id}
              {...{ decision, definition, projection, onOpenArtifact, checks }}
            />
          ))}
        </section>
      )}
      {remaining.length > 0 && (
        <section className="grid gap-2" aria-label={t('otherRelationships')}>
          <h3 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
            {t('otherRelationships')}
          </h3>
          {remaining.map((edge) => (
            <AgentCard
              key={edge.id}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-body"
            >
              <span>{flow.nodes.find((node) => node.id === edge.from)?.label}</span>
              <span className="text-caption text-muted-foreground">
                — {t(`relation.${edge.kind}`)} →
              </span>
              <span>{flow.nodes.find((node) => node.id === edge.to)?.label}</span>
            </AgentCard>
          ))}
        </section>
      )}
      {artifacts.length > 0 && (
        <section className="grid gap-2" aria-label={t('artifacts')}>
          <h3 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
            {t('artifacts')}
          </h3>
          {artifacts.map((artifact) => {
            const author = flow.edges.find(
              (edge) => edge.kind === 'author' && edge.to === artifact.id,
            );
            const authorId = artifact.executionIds[0];
            const authorExecution = authorId ? projection.executions[authorId] : undefined;
            const authorIteration = authorId
              ? runFlowExecutionIterationId(projection, authorId)
              : null;
            const sourceRound = authorIteration
              ? projection.iterations[authorIteration]?.no
              : undefined;
            const name =
              flow.nodes.find((node) => node.id === author?.from)?.label ??
              definition.nodes.find((node) => node.id === authorExecution?.nodeId)?.label;
            return (
              <AgentCard
                key={artifact.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="flex flex-wrap gap-2 text-subtitle"
                    style={{ fontVariationSettings: fontWeights.semibold }}
                  >
                    <span className="break-words">{artifact.label}</span>
                    {artifact.status === 'final' && (
                      <span className="text-caption text-success">{t('final')}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-caption text-muted-foreground">
                    {name && <span>{t('createdBy', { name })}</span>}
                    {sourceRound !== undefined && (
                      <span>{roundText('round', { no: sourceRound })}</span>
                    )}
                    <ObservedTime value={artifact.recordedAt} />
                  </div>
                </div>
                {artifact.current && artifact.artifactVersionId ? (
                  <Button
                    variant="tertiary"
                    onClick={() => onOpenArtifact(artifact.artifactVersionId ?? '')}
                  >
                    {t('open', { name: artifact.label })}
                  </Button>
                ) : (
                  <span className="text-caption text-muted-foreground">{t('metadataOnly')}</span>
                )}
              </AgentCard>
            );
          })}
        </section>
      )}
    </div>
  );
}

const LATEST: Readonly<Record<string, string>> = {};

/** A recorded routing fact. Configuration options never become an inferred selection. */
/** Recorded workflow decisions with their evidence, under the work flow; nothing without one. */
export function RunFlowDecisions({
  session,
  definition,
  onOpenArtifact,
  checks = [],
  selectedIterations = LATEST,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  onOpenArtifact: (id: string) => void;
  checks?: readonly RunFlowCheck[];
  /** The inspected round per Loop, as the work flow beside it shows them. */
  selectedIterations?: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('RunFlow');
  const projection = useStore(session, (s) => s.projection);
  const events = useStore(session, (s) => s.events);
  const decisions = useMemo(
    () => buildRunFlow(projection, events, definition, selectedIterations).decisions,
    [projection, events, definition, selectedIterations],
  );
  if (!projection || !decisions.length) return null;
  return (
    <section className="grid gap-4" aria-label={t('decisions')} data-testid="run-flow-decisions">
      <h3 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
        {t('decisions')}
      </h3>
      {decisions.map((decision) => (
        <DecisionDetail
          key={decision.id}
          {...{ decision, definition, projection, onOpenArtifact, checks }}
        />
      ))}
    </section>
  );
}

export function DecisionDetail({
  decision,
  definition,
  projection,
  onOpenArtifact,
  checks = [],
}: {
  decision: RunFlowDecision;
  definition: CorralDefinition;
  projection: RunProjection;
  onOpenArtifact: (id: string) => void;
  checks?: readonly RunFlowCheck[];
}) {
  const t = useTranslations('RunFlow');
  const loopText = useTranslations('RunLoop');
  const node = definition.nodes.find((entry) => entry.id === decision.nodeId);
  const optionIds = [
    ...new Set([
      ...definition.controlEdges
        .filter((edge) => edge.source === decision.nodeId)
        .map((edge) => edge.sourcePort),
      ...(decision.selectedPort ? [decision.selectedPort] : []),
    ]),
  ];
  const optionLabel = (port: string) => (t.has(`port.${port}`) ? t(`port.${port}`) : port);
  const options = optionIds.map((id) => {
    const edge = definition.controlEdges.find(
      (edge) => edge.source === decision.nodeId && edge.sourcePort === id,
    );
    const target = id === decision.selectedPort ? decision.targetNodeId : edge?.target;
    const targetPort = id === decision.selectedPort ? decision.targetPort : edge?.targetPort;
    const targetNode = definition.nodes.find((entry) => entry.id === target);
    const name = targetNode?.label ?? target;
    const effect = name
      ? targetNode?.type === 'loop' && (targetPort === 'repeat' || targetPort === 'exit')
        ? loopText(targetPort, { name })
        : t('nextNode', { name })
      : null;
    return { id, label: optionLabel(id), effects: effect ? [effect] : [] };
  });
  const reason =
    decision.reasonCode && t.has(`reason.${decision.reasonCode}`)
      ? t(`reason.${decision.reasonCode}`)
      : decision.reasonCode;
  const rule =
    node?.type === 'decision' && 'rule' in node
      ? t(`question.${node.rule}`)
      : (node?.label ?? decision.nodeId);
  return (
    <AgentCard className="grid gap-4 p-4" data-testid="decision-detail">
      <DecisionTree
        agent={{ name: node?.label ?? decision.nodeId }}
        decision={{ question: rule, options }}
        selectedId={decision.selectedPort}
        readOnly
        keyboard={false}
        context={reason ?? t('noRecordedBranch')}
        labels={{ options: t('branches'), selected: t('recordedBranch'), unknown: t('unrecorded') }}
      />
      <div className="grid gap-2 border-t border-border pt-3 text-caption text-muted-foreground">
        {decision.iterationId && projection.iterations[decision.iterationId] && (
          <span>{t('round', { round: projection.iterations[decision.iterationId]?.no ?? 0 })}</span>
        )}
        {decision.selectedPort && (
          <p className="text-foreground">
            {t('selected', { branch: optionLabel(decision.selectedPort) })}
          </p>
        )}
        <ObservedTime value={decision.recordedAt} />
        {decision.evidenceRefs.length > 0 ? (
          <div className="grid gap-1">
            <h4 className="text-foreground" style={{ fontVariationSettings: fontWeights.semibold }}>
              {t('evidence')}
            </h4>
            <ul className="grid gap-1">
              {decision.evidenceRefs.map((ref) => (
                <EvidenceSummary
                  key={`${ref.kind}:${ref.id}`}
                  evidence={ref}
                  {...{ projection, definition, checks, onOpenArtifact }}
                />
              ))}
            </ul>
          </div>
        ) : decision.status === 'observed' ? (
          <p>{t('noEvidence')}</p>
        ) : null}
        {decision.reviewVerdict && (
          <p>{t('reviewVerdict', { verdict: optionLabel(decision.reviewVerdict) })}</p>
        )}
        {decision.issues.length > 0 && (
          <ul className="list-outside list-disc pl-5">
            {[...new Set(decision.issues)].map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </div>
    </AgentCard>
  );
}

function EvidenceSummary({
  evidence,
  projection,
  definition,
  checks,
  onOpenArtifact,
}: {
  evidence: FlowEvidenceRef;
  projection: RunProjection;
  definition: CorralDefinition;
  checks: readonly RunFlowCheck[];
  onOpenArtifact: (id: string) => void;
}) {
  const t = useTranslations('RunFlow');
  const status = useTranslations('Status');
  const labelOf = (id: string) => definition.nodes.find((node) => node.id === id)?.label ?? id;
  const currentStatus = (value: string) =>
    t('currentStatus', { status: status.has(value) ? status(value) : value });
  const artifact =
    evidence.kind === 'artifact' || evidence.kind === 'review'
      ? projection.artifacts[evidence.id]
      : undefined;
  const approval = evidence.kind === 'approval' ? projection.approvals[evidence.id] : undefined;
  const task = evidence.kind === 'task' ? projection.tasks[evidence.id] : undefined;
  const check =
    evidence.kind === 'check' ? checks.find((value) => value.id === evidence.id) : undefined;
  const review = evidence.kind === 'review' ? projection.reviews[evidence.id] : undefined;
  const name =
    artifact?.name ??
    (approval
      ? approval.subjectVersionIds.map((id) => projection.artifacts[id]?.name ?? id).join(', ')
      : undefined) ??
    (task ? labelOf(task.nodeId) : undefined) ??
    check?.name ??
    evidence.id;
  const author = artifact ? projection.executions[artifact.authorExecutionId] : undefined;
  return (
    <li className="grid gap-1 rounded bg-muted/40 px-2.5 py-2" data-evidence-id={evidence.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground" style={{ fontVariationSettings: fontWeights.semibold }}>
          {t(`evidenceKind.${evidence.kind}`)} · {name}
        </span>
        {artifact && canReadArtifactBody(projection, evidence.id) && (
          <Button variant="ghost" onClick={() => onOpenArtifact(evidence.id)}>
            {t('open', { name })}
          </Button>
        )}
      </div>
      {author && <span>{t('createdBy', { name: labelOf(author.nodeId) })}</span>}
      {review && (
        <span>
          {t('reviewedArtifact', {
            name: projection.artifacts[review.targetVersionId]?.name ?? review.targetVersionId,
          })}
        </span>
      )}
      {approval && <span>{currentStatus(approval.status)}</span>}
      {task && (
        <>
          <span>{currentStatus(task.status)}</span>
          {task.submittedArtifactVersionIds.length > 0 && (
            <span>
              {t('taskOutputs', {
                names: task.submittedArtifactVersionIds
                  .map((id) => projection.artifacts[id]?.name ?? id)
                  .join(', '),
              })}
            </span>
          )}
        </>
      )}
      {check ? (
        <div className="flex flex-wrap gap-x-3">
          <span>{currentStatus(check.state)}</span>
          {check.verdict && (
            <span>{t('checkVerdict', { verdict: t(`verdict.${check.verdict}`) })}</span>
          )}
          {check.exitCode !== undefined && check.exitCode !== null && (
            <span>{t('exitCode', { code: check.exitCode })}</span>
          )}
          {check.timedOut && <span>{t('checkTimedOut')}</span>}
        </div>
      ) : evidence.kind === 'check' ? (
        <span>{t('checkUnavailable')}</span>
      ) : null}
      {!artifact && !approval && !task && !check && evidence.kind !== 'check' && (
        <span>{t('evidenceUnavailable')}</span>
      )}
    </li>
  );
}

function ObservedTime({ value }: { value: string | null }) {
  const format = useFormatter();
  const t = useTranslations('RunFlow');
  return value ? (
    <time dateTime={value}>
      {t('recordedAt', {
        time: format.dateTime(new Date(value), {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      })}
    </time>
  ) : null;
}
