/** Pure presentation decisions for the chat widgets. No clock, network, or DOM. */

export function widgetReadState(input: {
  presentationRunId: string | null;
  projectionRunId: string | null;
  sharedRunId: string | null;
  sharedStreamError: string | null;
  sharedMissingRunId: string | null;
  archiveFailed: boolean;
}): 'empty' | 'loading' | 'ready' | 'error' {
  const failed =
    input.sharedRunId === input.presentationRunId &&
    (input.sharedStreamError !== null || input.sharedMissingRunId === input.presentationRunId);
  return !input.presentationRunId
    ? 'empty'
    : failed
      ? 'error'
      : input.projectionRunId === input.presentationRunId
        ? 'ready'
        : input.archiveFailed
          ? 'error'
          : 'loading';
}

export interface PlanRef {
  scope: 'execution' | 'team';
  executionId: string;
  attemptNo: number;
  revision: number;
  criteriaVersionId: string;
  bodyRef: string;
  bodyHash: string;
}

export interface PlanItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanBody {
  revision: number;
  executionId: string;
  attemptNo: number;
  criteriaVersionId: string;
  scope: 'execution' | 'team';
  items: PlanItem[];
}

export type PlanBodyView =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'mismatch' }
  | { state: 'stale-criteria'; plan: PlanBody; completed: number; total: number }
  | {
      state: 'ready';
      plan: PlanBody;
      completed: number;
      total: number;
      runFinished: boolean;
      planFinished: boolean;
    };

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export function planBodyStatus(input: {
  ref: PlanRef;
  parsed: PlanBody | null;
  textPresent: boolean;
  failed: boolean;
  hashMatches: boolean | null;
  currentCriteriaVersionId: string | null;
  runStatus?: string;
}): PlanBodyView {
  if (input.failed) return { state: 'error' };
  if (!input.textPresent) return { state: 'loading' };
  if (!input.parsed) return { state: 'error' };
  const parsed = input.parsed;
  const same =
    parsed.revision === input.ref.revision &&
    parsed.executionId === input.ref.executionId &&
    parsed.attemptNo === input.ref.attemptNo &&
    parsed.criteriaVersionId === input.ref.criteriaVersionId &&
    parsed.scope === input.ref.scope;
  if (!same || input.hashMatches === false) return { state: 'mismatch' };
  if (input.hashMatches === null) return { state: 'loading' };
  const completed = parsed.items.filter((item) => item.status === 'completed').length;
  const total = parsed.items.length;
  if (
    input.currentCriteriaVersionId &&
    parsed.criteriaVersionId !== input.currentCriteriaVersionId
  ) {
    return { state: 'stale-criteria', plan: parsed, completed, total };
  }
  const runStatus = input.runStatus ?? 'running';
  return {
    state: 'ready',
    plan: parsed,
    completed,
    total,
    runFinished: TERMINAL.has(runStatus),
    planFinished: total > 0 && completed === total,
  };
}

export function workPlanPreferenceKey(input: {
  sessionId: string;
  runId: string;
  scope: string;
  owner: string;
  attempt: number;
}) {
  return `corral:work-plan:v1:${input.sessionId}:${input.runId}:${input.scope}:${input.owner}:${input.attempt}`;
}

/** Auto opens while the run is not a success. A manual open or closed choice stays. */
export function workPlanOpen(preference: 'auto' | 'open' | 'closed', runStatus: string) {
  if (preference === 'open') return true;
  if (preference === 'closed') return false;
  return runStatus !== 'succeeded';
}

export interface ExecutionFact {
  executionId: string;
  roleId: string;
  roleName: string;
  status: string;
  ended: boolean;
  attemptNo?: number;
}

export interface PlanChoice {
  key: string;
  label: string;
  live: boolean;
  lastTeam: boolean;
  status: string;
  attemptNo: number;
  ref: PlanRef;
}

export function selectPresentedPlan(input: {
  plans: PlanRef[];
  executions: ExecutionFact[];
  manualKey: string | null;
}): {
  selected: PlanRef | null;
  selectedKey: string | null;
  choices: PlanChoice[];
  auto: boolean;
  multiple: boolean;
} {
  const choices: PlanChoice[] = [];
  for (const ref of input.plans) {
    if (ref.scope === 'team') {
      const owner = input.executions.find((execution) => execution.executionId === ref.executionId);
      const ownerEnded = owner ? owner.ended : true;
      choices.push({
        key: 'team',
        label: 'team',
        live: !ownerEnded,
        lastTeam: ownerEnded,
        status: owner?.status ?? 'unknown',
        attemptNo: ref.attemptNo,
        ref,
      });
    } else {
      const execution = input.executions.find((item) => item.executionId === ref.executionId);
      choices.push({
        key: ref.executionId,
        label: execution?.roleName ?? ref.executionId,
        live: Boolean(execution && !execution.ended),
        lastTeam: false,
        status: execution?.status ?? 'unknown',
        attemptNo: ref.attemptNo,
        ref,
      });
    }
  }
  const manual = input.manualKey ? choices.find((choice) => choice.key === input.manualKey) : null;
  if (input.manualKey) {
    return {
      selected: manual?.ref ?? null,
      selectedKey: input.manualKey,
      choices,
      auto: false,
      multiple: choices.length > 1,
    };
  }
  // Creation order is stable; latest event order must not make the selected role hop.
  // A working child has priority over a parent waiting for that child.
  const liveExecutions = input.executions.filter((execution) => !execution.ended);
  const hasPlan = (execution: ExecutionFact) =>
    choices.some((choice) => choice.key === execution.executionId);
  const liveExecution =
    liveExecutions.find((execution) => execution.status === 'active' && hasPlan(execution)) ??
    liveExecutions.find(hasPlan);
  const liveChoice = liveExecution
    ? choices.find((choice) => choice.key === liveExecution.executionId)
    : null;
  const team = choices.find((choice) => choice.key === 'team');
  const selected =
    liveChoice ??
    (team?.live ? team : null) ??
    (liveExecutions.length === 0
      ? ([...input.executions]
          .reverse()
          .map((execution) => choices.find((choice) => choice.key === execution.executionId))
          .find(Boolean) ?? team)
      : null) ??
    null;
  return {
    selected: selected?.ref ?? null,
    selectedKey: selected?.key ?? null,
    choices,
    auto: true,
    multiple: choices.length > 1,
  };
}

export interface ContextCall {
  modelCallId: string;
  executionId: string;
  recordedAt: string;
  coverage: 'messages' | 'request' | 'legacy-messages';
  completeness: 'complete' | 'partial' | 'unmeasured' | 'error' | 'legacy';
  messageTokens: number | null;
  usedTokens: number | null;
  parts: { category: string; tokens: number; omission?: string }[];
  windowTokens: number | null;
  providerInput: number | null;
  providerCacheRead: number | null;
  providerOutput: number | null;
  roleLabel?: string;
  modelLabel?: string;
  method?: string;
  omissions?: string[];
  reserveTokens?: number | null;
  measurementStage?: 'assembled' | 'payload' | 'legacy';
}

export interface ContextPresentation {
  kind: 'messages' | 'request' | 'partial' | 'highest' | 'empty';
  tokens: number | null;
  percent: number | null;
  /** Visual fill, clamped. The numeric percent is not hidden when it exceeds 100. */
  barPercent: number | null;
  freeTokens: number | null;
  windowTokens: number | null;
  awaitingRefresh: boolean;
  providerInput: number | null;
  providerCacheRead: number | null;
  providerOutput: number | null;
  parts: ContextCall['parts'];
  unmeasuredExecutions: number;
  executionId: string | null;
  modelCallId: string | null;
  recordedAt: string | null;
  roleLabel: string | null;
  modelLabel: string | null;
  coverage: ContextCall['coverage'] | null;
  completeness: ContextCall['completeness'];
  method: string | null;
  omissions: string[];
  reserveTokens: number | null;
  measurementStage: ContextCall['measurementStage'] | null;
}

export function presentContext(input: {
  calls: ContextCall[];
  compactions: { executionId: string; phase: string; recordedAt: string }[];
  selectedExecutionId: string | null;
  executionIds?: string[];
  /** The next request's model window. It must not change a recorded request. */
  composerWindow?: number;
}): ContextPresentation {
  void input.composerWindow;
  const latest = new Map<string, ContextCall>();
  for (const call of input.calls) latest.set(call.executionId, call);
  const executionIds = new Set([...latest.keys(), ...(input.executionIds ?? [])]);
  const blank: ContextPresentation = {
    kind: 'empty',
    tokens: null,
    percent: null,
    barPercent: null,
    freeTokens: null,
    windowTokens: null,
    awaitingRefresh: false,
    providerInput: null,
    providerCacheRead: null,
    providerOutput: null,
    parts: [],
    unmeasuredExecutions: executionIds.size,
    executionId: input.selectedExecutionId,
    modelCallId: null,
    recordedAt: null,
    roleLabel: null,
    modelLabel: null,
    coverage: null,
    completeness: 'unmeasured',
    method: null,
    omissions: [],
    reserveTokens: null,
    measurementStage: null,
  };
  if (!latest.size) return blank;

  const project = (call: ContextCall, kind: ContextPresentation['kind'], unmeasured = 0) => {
    const full =
      call.coverage === 'request' &&
      call.completeness === 'complete' &&
      call.usedTokens != null &&
      call.windowTokens;
    const percent = full ? Math.round((call.usedTokens! / call.windowTokens!) * 100) : null;
    const awaitingRefresh = input.compactions.some(
      (compaction) =>
        compaction.executionId === call.executionId &&
        compaction.phase === 'completed' &&
        compaction.recordedAt > call.recordedAt,
    );
    const tokens =
      call.coverage === 'legacy-messages' || call.coverage === 'messages'
        ? call.messageTokens
        : (call.usedTokens ?? call.messageTokens);
    return {
      kind:
        call.coverage === 'legacy-messages' || call.coverage === 'messages'
          ? 'messages'
          : full
            ? kind
            : 'partial',
      tokens,
      percent,
      barPercent: percent == null ? null : Math.min(100, Math.max(0, percent)),
      freeTokens:
        full && call.windowTokens != null && call.usedTokens != null
          ? call.windowTokens - call.usedTokens
          : null,
      windowTokens: call.windowTokens,
      awaitingRefresh,
      providerInput: call.providerInput,
      providerCacheRead: call.providerCacheRead,
      providerOutput: call.providerOutput,
      parts: call.parts,
      unmeasuredExecutions: unmeasured,
      executionId: call.executionId,
      modelCallId: call.modelCallId,
      recordedAt: call.recordedAt,
      roleLabel: call.roleLabel ?? null,
      modelLabel: call.modelLabel ?? null,
      coverage: call.coverage,
      completeness: call.completeness,
      method: call.method ?? null,
      omissions: call.omissions ?? [],
      reserveTokens: call.reserveTokens ?? null,
      measurementStage: call.measurementStage ?? null,
    } satisfies ContextPresentation;
  };

  if (input.selectedExecutionId) {
    const call = latest.get(input.selectedExecutionId);
    return call ? project(call, 'request') : blank;
  }
  const onlyCall = latest.values().next().value;
  if (executionIds.size === 1 && onlyCall) return project(onlyCall, 'request');

  let best: { call: ContextCall; ratio: number } | null = null;
  let unmeasured = executionIds.size - latest.size;
  for (const call of latest.values()) {
    const full =
      call.coverage === 'request' &&
      call.completeness === 'complete' &&
      call.usedTokens != null &&
      call.windowTokens;
    if (!full || !call.windowTokens || call.usedTokens == null) {
      unmeasured += 1;
      continue;
    }
    const ratio = call.usedTokens / call.windowTokens;
    if (!best || ratio > best.ratio) best = { call, ratio };
  }
  if (!best) return { ...blank, kind: 'partial', unmeasuredExecutions: unmeasured };
  return {
    ...project(best.call, 'highest', unmeasured),
    kind: 'highest',
    unmeasuredExecutions: unmeasured,
  };
}

export function actionRequired(input: {
  pendingApprovals: number;
  pendingQuestions: number;
  failedEffects: number;
  unclearEffects: number;
  runStatus?: string;
}) {
  const failed = Math.max(
    input.failedEffects,
    input.runStatus === 'failed' || input.runStatus === 'interrupted' ? 1 : 0,
  );
  const kinds = [
    input.pendingApprovals ? 'approval' : null,
    input.pendingQuestions ? 'question' : null,
    failed ? 'failure' : null,
    input.unclearEffects ? 'unclear' : null,
  ].filter((kind): kind is 'approval' | 'question' | 'failure' | 'unclear' => kind !== null);
  return {
    visible: kinds.length > 0,
    needsUser: input.pendingApprovals + input.pendingQuestions > 0,
    hasFailure: failed + input.unclearEffects > 0,
    count: input.pendingApprovals + input.pendingQuestions + failed + input.unclearEffects,
    summary: kinds.length === 0 ? 'none' : kinds.length === 1 ? kinds[0]! : 'mixed',
  };
}

export function agentActivity(executions: ExecutionFact[]) {
  const waitingStatuses = new Set([
    'queued',
    'ready',
    'waiting_children',
    'waiting_message',
    'waiting_approval',
    'pausing',
    'paused',
  ]);
  const working = executions.filter((execution) => execution.status === 'active').length;
  const waiting = executions.filter(
    (execution) => !execution.ended && waitingStatuses.has(execution.status),
  ).length;
  const failed = executions.filter((execution) => execution.status === 'failed').length;
  return executions.length > 1 || waiting > 0 || failed > 0
    ? { total: executions.length, working, waiting, failed }
    : null;
}

export function toolRows(
  calls: readonly { toolCallId: string; name: string; phase: string; effect?: string | null }[],
) {
  const rows = new Map<string, { id: string; name: string; tone: string }>();
  for (const call of calls) {
    const tone =
      call.effect === 'unknown'
        ? 'unknown'
        : call.effect === 'cancelled'
          ? 'cancelled'
          : call.effect === 'failed' || call.phase === 'failed' || call.phase === 'blocked'
            ? call.phase === 'blocked'
              ? 'blocked'
              : 'failed'
            : call.effect === 'succeeded' || call.phase === 'finished'
              ? 'ok'
              : 'running';
    rows.set(call.toolCallId, { id: call.toolCallId, name: call.name, tone });
  }
  return [...rows.values()];
}

export type WidgetChip = 'context' | 'environment' | 'agents' | 'changes';

export function visibleWidgets(input: {
  hasContext: boolean;
  agents: { total: number; working: number; waiting: number; failed: number; delegated: boolean };
  changes: { kind: string } | null;
  environment: { simulated: boolean; restricted: boolean } | null;
  toolCount?: number;
  resultCount?: number;
}): WidgetChip[] {
  const chips: WidgetChip[] = [];
  if (input.hasContext) chips.push('context');
  if (input.environment && (input.environment.simulated || input.environment.restricted))
    chips.push('environment');
  const agents = input.agents;
  if (agents.total > 1 || agents.delegated || agents.waiting > 0 || agents.failed > 0)
    chips.push('agents');
  if (input.changes) chips.push('changes');
  return chips;
}

export function changesPresentation(input: {
  baselineApplied: boolean;
  provisional: boolean;
  state: 'loading' | 'error' | 'unavailable' | 'ready';
  files: number;
  lines: number | null;
  uncounted: number;
}):
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | {
      kind: 'count';
      files: number;
      lines: number | null;
      provisional: boolean;
      uncounted: number;
    } {
  if (!input.baselineApplied || input.state === 'unavailable') return { kind: 'unavailable' };
  if (input.state === 'error') return { kind: 'error' };
  if (input.state === 'loading') return { kind: 'loading' };
  return {
    kind: 'count',
    files: input.files,
    lines: input.lines,
    provisional: input.provisional,
    uncounted: input.uncounted,
  };
}

export function activityLine(input: {
  runStatus: string;
  startedAt: string | null;
  endedAt: string | null;
  now: string;
  planTitle: string | null;
  planVisible: boolean;
  toolName: string | null;
  failed: boolean;
  needsUser: boolean;
}) {
  const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(input.runStatus);
  const end = input.endedAt ?? (!terminal ? input.now : null);
  const elapsedMs = input.startedAt && end ? Date.parse(end) - Date.parse(input.startedAt) : null;
  const frozen = Boolean(input.endedAt) || terminal;
  let text = 'working';
  if (input.needsUser && !terminal) text = 'user';
  else if (input.failed || input.runStatus === 'failed') text = 'failed';
  else if (
    ['paused', 'pausing', 'cancelling', 'cancelled', 'interrupted'].includes(input.runStatus)
  )
    text = input.runStatus;
  else if (!terminal && !input.planVisible && input.planTitle) text = input.planTitle;
  else if (!terminal && input.toolName && !(input.planVisible && input.planTitle))
    text = input.toolName;
  else if ((input.planVisible && input.planTitle) || terminal)
    text = elapsedMs != null ? 'elapsed' : 'record';
  return { text, elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null, frozen };
}
