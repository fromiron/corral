import type {
  CorralDefinition,
  OutputNode,
  RequiredOutputReview,
  RunEvent,
} from '@corral/contracts';
import {
  type IterationView,
  type RunProjection,
  reviewedOutputBinding,
  stepResult,
  type WorkflowBranchView,
} from '@corral/core';

interface QuestionCounts {
  total: number;
  open: number;
  answered: number;
  cancelled: number;
  timed_out: number;
}

interface ObservationRecord {
  delivered: number;
  notDelivered: number;
  late: number;
  deliveredSeqs: number[];
  notDeliveredSeqs: number[];
  lateSeqs: number[];
}

interface ReviewRecord {
  outputId: string;
  binding: string;
  bindingId: string;
  loopId: string;
  rounds: number;
  round: { id: string; no: number } | null;
  status: 'waiting' | 'inProgress' | 'passed' | 'exhausted' | 'cancelled' | 'failed' | 'unrecorded';
  submissions: { id: string; name: string; version: number; author: string }[];
}

export interface TeamRecord {
  questions: QuestionCounts | null;
  observation: ObservationRecord | null;
  reviews: ReviewRecord[];
}

function observationRecord(p: RunProjection, events: readonly RunEvent[]): ObservationRecord {
  const deliveredSeqs: number[] = [];
  const notDeliveredSeqs: number[] = [];
  const deliverySeq = new Map<string, number>();
  const lateSeqs: number[] = [];
  const seenCalls = new Set<string | number>();
  for (const event of events) {
    if (event.runId !== p.runId || event.runSeq > p.lastSeq) continue;
    if (event.type === 'directive.dispatched' || event.type === 'directive.undelivered') {
      const directive = p.directives[event.payload.directiveId];
      const status = event.type === 'directive.dispatched' ? 'delivered' : event.payload.status;
      if (directive?.origin === 'advice' && directive.status === status) {
        deliverySeq.set(directive.directiveId, event.runSeq);
      }
      continue;
    }
    // Only a model result from the observer is a late review, not a dispatch or a responder reply.
    if (
      event.type !== 'observation.late' ||
      event.payload.originalEventType !== 'model.finished' ||
      !event.executionId ||
      !p.executions[event.executionId]?.advisor
    )
      continue;
    const call = event.payload.originalRef ?? event.runSeq;
    if (seenCalls.has(call)) continue;
    seenCalls.add(call);
    lateSeqs.push(event.runSeq);
  }
  // A directive is evidence of delivery, not another opinion. In a partial log, its admitted
  // advice still has a stable sequence where the reader can inspect its origin.
  for (const advice of Object.values(p.advice ?? {})) {
    if (advice.delivery === 'preserve') {
      notDeliveredSeqs.push(advice.acceptedSeq);
      continue;
    }
    const directive = advice.directiveId ? p.directives[advice.directiveId] : undefined;
    if (directive?.origin !== 'advice') continue;
    switch (directive.status) {
      case 'delivered':
        deliveredSeqs.push(deliverySeq.get(directive.directiveId) ?? advice.acceptedSeq);
        break;
      case 'expired':
      case 'not_delivered':
      case 'rejected':
        notDeliveredSeqs.push(deliverySeq.get(directive.directiveId) ?? advice.acceptedSeq);
        break;
      // Queued, attaching and delivery-unknown are not evidence either way.
    }
  }

  return {
    delivered: deliveredSeqs.length,
    notDelivered: notDeliveredSeqs.length,
    late: lateSeqs.length,
    deliveredSeqs,
    notDeliveredSeqs,
    lateSeqs,
  };
}

function reviewRecord(
  p: RunProjection,
  definition: CorralDefinition,
  output: OutputNode,
  gate: RequiredOutputReview,
  branch: WorkflowBranchView | undefined,
): ReviewRecord {
  const roundIds = p.loopIterations[gate.loopNodeId] ?? [];
  const lastId = roundIds.at(-1);
  const latest = lastId ? p.iterations[lastId] : undefined;
  const result: ReviewRecord = {
    outputId: output.id,
    binding: gate.bindingName,
    bindingId: gate.bindingId ?? `${gate.sourceNodeId}:${gate.bindingName}`,
    loopId: gate.loopNodeId,
    rounds: roundIds.length,
    round: latest ? { id: latest.iterationId, no: latest.no } : null,
    status: 'unrecorded',
    submissions: [],
  };
  if (!reviewedOutputBinding(output, gate)) return result;

  if (p.status === 'cancelled') {
    result.status = 'cancelled';
    return result;
  }
  if (
    latest?.outcome === 'cap_reached' ||
    latest?.outcome === 'stalled' ||
    (p.status === 'failed' && p.statusReason?.startsWith(`loop_exhausted: ${gate.loopNodeId} `))
  ) {
    result.status = 'exhausted';
    return result;
  }
  if (p.status === 'failed') {
    result.status = 'failed';
    return result;
  }
  if (latest?.outcome === 'cancelled') {
    result.status = 'cancelled';
    return result;
  }

  const final = p.output?.nodeId === output.id ? p.output : null;
  const completed = stepResult(p, gate.sourceNodeId);
  const finalIds = new Set<string>();
  if (final) {
    const author =
      definition.nodes.find((n) => n.id === gate.sourceNodeId)?.label ?? gate.sourceNodeId;
    for (const id of final.artifactVersionIds) {
      if (finalIds.has(id)) continue;
      const version = p.artifacts[id];
      if (!version || p.executions[version.authorExecutionId]?.nodeId !== gate.sourceNodeId)
        continue;
      finalIds.add(id);
      result.submissions.push({ id, version: version.version, name: version.name, author });
    }
  }

  // Match the coordinator's strict decision: the latest branch of *this gate*, a current
  // passing review reference, and its exact target. A Loop's pass outcome alone is not proof.
  const evidenceRound = branch?.iterationId ? p.iterations[branch.iterationId] : undefined;
  if (
    branch?.selectedPort === 'pass' &&
    evidenceRound?.loopNodeId === gate.loopNodeId &&
    (final || (!p.output && latest?.iterationId === evidenceRound.iterationId))
  ) {
    const passed = passingVersions(p, gate, branch, evidenceRound);
    // Before finalization only a completed producer submission is a candidate. Afterwards, the
    // actual output and its authors are independent evidence; never quietly drop an unmatched V1.
    const candidates = final ? finalIds : completed;
    if (
      (final ? finalIds.size > 0 : completed.length > 0) &&
      (!final ||
        !completed.length ||
        (completed.length === finalIds.size && completed.every((id) => finalIds.has(id))))
    ) {
      let allPassed = true;
      for (const id of candidates) {
        const version = p.artifacts[id];
        if (
          !passed.has(id) ||
          !version ||
          p.executions[version.authorExecutionId]?.nodeId !== gate.sourceNodeId
        ) {
          allPassed = false;
          break;
        }
      }
      if (allPassed) {
        result.status = 'passed';
        result.round = { id: evidenceRound.iterationId, no: evidenceRound.no };
        return result;
      }
    }
  }
  if (!final && !p.output && p.status !== 'succeeded' && p.status !== 'interrupted') {
    result.status = latest ? 'inProgress' : 'waiting';
  }
  return result;
}

function passingVersions(
  p: RunProjection,
  gate: RequiredOutputReview,
  branch: WorkflowBranchView,
  round: IterationView,
): Set<string> {
  const passed = new Set<string>();
  for (const ref of branch.evidenceRefs) {
    if (ref.kind !== 'review') continue;
    const review = p.reviews[ref.id];
    if (
      !review ||
      review.stale ||
      review.verdict !== 'pass' ||
      review.criteriaVersionId !== round.criteriaVersionId ||
      review.criteriaVersionId !== p.currentCriteriaVersionId
    )
      continue;
    const artifact = p.artifacts[ref.id];
    if (artifact) {
      const reviewer = p.executions[artifact.authorExecutionId];
      if (reviewer?.nodeId !== gate.reviewerNodeId || reviewer.iterationId !== round.iterationId)
        continue;
    }
    passed.add(review.targetVersionId);
  }
  return passed;
}

/** Recorded team advice and required reviews, never inferred from a role's display name. */
export function selectTeamRecord(
  projection: RunProjection | null,
  definition: CorralDefinition | null,
  events: readonly RunEvent[],
  executionDefinition?: CorralDefinition | null,
): TeamRecord | null {
  if (!projection) return null;
  const counts: QuestionCounts = { total: 0, open: 0, answered: 0, cancelled: 0, timed_out: 0 };
  for (const q of Object.values(projection.questions)) {
    if (!q.sharedOutrider) continue;
    counts.total++;
    counts[q.status]++;
  }
  const questions = definition?.sharedOutrider || counts.total ? counts : null;
  const reviews: ReviewRecord[] = [];
  // An old execution copy still identifies a gate and its evidence, but cannot prove
  // that nobody used an authored policy which the planner may have stripped away.
  const gateDefinition = definition ?? executionDefinition;
  if (gateDefinition) {
    let branches: Map<string, WorkflowBranchView> | undefined;
    for (const node of gateDefinition.nodes) {
      if (node.type !== 'output' || !node.requiredReviews?.length) continue;
      if (!branches) {
        branches = new Map();
        for (const b of Object.values(projection.workflowBranches ?? {})) {
          const previous = branches.get(b.nodeId);
          if (!previous || previous.runSeq < b.runSeq) branches.set(b.nodeId, b);
        }
      }
      for (const gate of node.requiredReviews) {
        const review = reviewRecord(
          projection,
          gateDefinition,
          node,
          gate,
          branches.get(gate.decisionNodeId),
        );
        if (definition || review.round || review.submissions.length) reviews.push(review);
      }
    }
  }
  if (definition && !questions && !reviews.length) return null;
  const observations = observationRecord(projection, events);
  const observation =
    definition?.sharedOutrider?.observation ||
    observations.delivered ||
    observations.notDelivered ||
    observations.late
      ? observations
      : null;
  return questions || reviews.length || observation ? { questions, reviews, observation } : null;
}
