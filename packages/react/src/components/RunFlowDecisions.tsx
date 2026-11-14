import type { CorralDefinition } from '@corral/contracts';
import { canReadArtifactBody, type RunProjection } from '@corral/core';
import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { AgentCard, Button, DecisionTree, fontWeights } from '../design-kit/index.ts';
import { type FlowEvidenceRef, type RunFlowDecision, runFlowDecisions } from '../run/flow.ts';
import type { RunSessionStore } from '../run/session.ts';

/** Only named verification facts cross the host boundary; output text stays in Checks. */
export interface RunFlowCheck {
  id: string;
  name: string;
  state: string;
  verdict?: 'pass' | 'fail' | 'inconclusive' | 'not_evaluated';
  exitCode?: number | null;
  timedOut?: boolean;
}

const LATEST: Readonly<Record<string, string>> = {};

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
    () => runFlowDecisions(projection, events, definition, selectedIterations),
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
