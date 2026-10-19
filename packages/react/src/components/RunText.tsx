import type { RunEvent } from '@corral/contracts';
import { useTranslations } from 'use-intl';

// Words for run facts (roadmap UX-A4). Event types and reason codes stay visible where they are
// precise (Timeline detail, filters); everywhere a person reads, they read a sentence.

type Values = Record<string, string | number>;
type Described = { key: string; values: Values } | null;

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' ? value : 0);

/** Message key and values for an event, or null when there is no sentence for it. */
export function describeEvent(
  event: RunEvent,
  labelOf: (executionId: string | undefined) => string,
  nodeLabel: (nodeId: string) => string,
): Described {
  const p = event.payload as Record<string, unknown>;
  const actor = labelOf(str(p.executionId) || event.executionId);
  const of = (key: string, values: Values = {}): Described => ({ key, values });
  switch (event.type) {
    case 'run.started':
      return of(p.mode === 'live' ? 'runStartedLive' : 'runStartedMock');
    case 'run.state_changed':
      return of('runState', { to: str(p.to) });
    case 'run.interrupted':
      return of('runInterrupted');
    case 'execution.created':
      return of('executionCreated', { node: nodeLabel(str(p.nodeId)) });
    case 'execution.state_changed':
      return of('executionState', { node: actor, to: str(p.to) });
    case 'execution.settled':
      return of('executionSettled', { node: actor, outcome: str(p.outcome) });
    case 'task.created':
      return of('taskCreated', { node: nodeLabel(str(p.nodeId)) });
    case 'task.attempt_assigned':
      return of('taskAssigned', { node: actor });
    case 'task.submitted':
      return of('taskSubmitted', { node: actor });
    case 'task.completed':
      return of('taskCompleted');
    case 'task.blocked':
      return of('taskBlocked', { cause: str(p.cause) });
    case 'message.question_created':
      return of('questionCreated', {
        node: labelOf(str(p.senderExecutionId)),
        target: nodeLabel(str(p.targetNodeId)),
      });
    case 'message.answer_committed':
      return of('answerCommitted', { node: labelOf(str(p.responderExecutionId)) });
    case 'message.closed':
      return of('questionClosed', { outcome: str(p.outcome) });
    case 'artifact.version_created':
      return of('versionCreated', {
        node: labelOf(str(p.authorExecutionId)),
        name: str(p.name),
        version: num(p.version),
      });
    case 'artifact.read':
      return of('versionRead', { node: actor });
    case 'review.recorded':
      return of('reviewRecorded', { verdict: str(p.verdict) });
    case 'review.stale':
      return of('reviewStale');
    case 'loop.iteration_started':
      return of('roundStarted', { no: num(p.no), loop: nodeLabel(str(p.loopNodeId)) });
    case 'loop.iteration_finished':
      return of('roundFinished', { outcome: str(p.outcome), loop: nodeLabel(str(p.loopNodeId)) });
    case 'approval.requested':
      return of('approvalRequested', { kind: str(p.kind) });
    case 'approval.resolved':
      return of('approvalResolved', { decision: str(p.decision) });
    case 'directive.accepted':
      return of('directiveAccepted', { node: labelOf(str(p.targetExecutionId)) });
    case 'directive.attached':
      return of('directiveAttached');
    case 'directive.dispatched':
      return of('directiveDispatched');
    case 'directive.undelivered':
      return of('directiveUndelivered', { status: str(p.status) });
    case 'patch.committed':
      return of('patchCommitted', { kind: str(p.kind) });
    case 'patch.activated':
      return of('patchActivated');
    case 'effect.admitted':
      return of('effectAdmitted', { kind: str(p.kind) });
    case 'effect.dispatch_observed':
      return of('effectDispatched');
    case 'effect.settled':
      return of('effectSettled', { outcome: str(p.outcome) });
    case 'tool.requested':
      return of('toolRequested', { node: actor, name: str(p.name) });
    case 'tool.allowed':
      return of('toolAllowed');
    case 'tool.blocked':
      return of('toolBlocked', { reason: str(p.reason) });
    case 'tool.started':
      return of('toolStarted');
    case 'tool.finished':
      return of(p.error ? 'toolFailed' : 'toolFinished');
    case 'model.request_prepared':
      return of('modelRequest', { node: actor });
    case 'model.finished':
      return of('modelFinished', { node: actor });
    case 'model.usage_reconciled':
      return of('usageReconciled');
    case 'budget.reserved':
      return of('budgetReserved');
    case 'budget.settled':
      return of('budgetSettled');
    case 'limit.reached':
      return of('limitReached', { kind: str(p.limitKind), used: num(p.used), max: num(p.max) });
    case 'cancel.requested':
      return of('cancelRequested');
    case 'cancel.confirmed':
      return of('cancelConfirmed');
    case 'observation.late':
      return of('observationLate', { what: str(p.originalEventType) });
    case 'output.finalized':
      return of('outputFinalized');
    case 'decision.requested':
      return of('decisionRequested', { provider: str(p.provider) });
    case 'decision.observed':
      return of('decisionObserved', { provider: str(p.provider), level: str(p.answer) });
    case 'decision.failed':
      return of('decisionFailed', { provider: str(p.provider), reason: str(p.reason) });
    default:
      return null;
  }
}

export function EventText({
  event,
  labelOf,
  nodeLabel,
}: {
  event: RunEvent;
  labelOf: (executionId: string | undefined) => string;
  nodeLabel: (nodeId: string) => string;
}) {
  const t = useTranslations('Events');
  const described = describeEvent(event, labelOf, nodeLabel);
  return <>{described ? t(described.key, described.values) : event.type}</>;
}

const REASONS = new Set([
  'user_input_requested',
  'run_requested',
  'validation_passed',
  'output_finalized',
  'approval_requested',
  'pause_requested',
  'safe_boundary_reached',
  'resumed',
  'cancel_requested',
  'cancel_confirmed',
  'backend_restarted',
  'required_task_cancelled',
  'required_task_cancelling',
  'task_restarted',
  'cancellation_cleanup_failed',
  'termination_unconfirmed',
  'execution_failed',
  'internal_error',
  'loop_hard_cap_reached',
  'needs_user',
  'runner_finished_without_output',
  'loop_cap_declined',
  'rejected',
  'final_output_rejected',
]);

/** A run status reason code as a sentence; an unknown code is shown as it is. */
export function RunReason({
  code,
  nodeLabel,
}: {
  code: string;
  nodeLabel: (id: string) => string;
}) {
  const t = useTranslations('RunReasons');
  const at = code.indexOf(': ');
  const head = at < 0 ? code : code.slice(0, at);
  const rest = at < 0 ? '' : code.slice(at + 2);
  if (!REASONS.has(head)) return <>{code}</>;
  const [first = ''] = rest.split(' ');
  return <>{t(head, { detail: rest, node: nodeLabel(first) })}</>;
}
