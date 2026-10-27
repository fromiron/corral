/** Pure presentation decisions for the chat widgets. No clock, network, or DOM. */
import type { RunProjection } from '@corral/core';

/** Shell services can change files after the launch tool has already finished. */
export function fileChangeSignals(
  calls: readonly { name: string; phase?: string }[],
  status: string | undefined,
  live: boolean,
) {
  const mutations = new Set([
    'write_file',
    'delete_file',
    'move_file',
    'write',
    'edit',
    'edit_hashline',
    'run_command',
  ]);
  return {
    revision: calls.filter(
      (call) => mutations.has(call.name) && (call.phase === 'finished' || call.phase === 'failed'),
    ).length,
    poll:
      live &&
      status === 'running' &&
      calls.some(
        (call) =>
          call.name === 'run_command' && (call.phase === 'running' || call.phase === 'finished'),
      ),
  };
}

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

/** Why an outcome is unclear: an effect, usage still held against the budget, or a stop. */
export type UnclearCause = 'effect' | 'usage' | 'termination';

export function actionRequired(input: {
  pendingApprovals: number;
  pendingQuestions: number;
  failedEffects: number;
  unclearEffects: number;
  unclearCauses?: UnclearCause[];
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
    unclearCauses: input.unclearEffects ? (input.unclearCauses ?? ['effect']) : [],
  };
}

const unclearCopy = {
  effect: 'actionUnclear',
  usage: 'actionUsageUnknown',
  termination: 'actionStopUnconfirmed',
} as const;

/** Widgets message keys for the attention banner; several unclear causes are each named. */
export function actionCopy(action: ReturnType<typeof actionRequired>) {
  if (!action.visible) return [];
  if (action.summary === 'approval') return ['actionApproval'] as const;
  if (action.summary === 'question') return ['actionQuestion'] as const;
  if (action.summary === 'failure') return ['actionFailure'] as const;
  if (action.summary === 'unclear') return action.unclearCauses.map((cause) => unclearCopy[cause]);
  return ['actionMixed'] as const;
}

export function effectAttention(projection: RunProjection | null) {
  const effects = Object.values(projection?.effects ?? {});
  const budgetUnknown =
    (projection?.budget.unknownOutstanding ?? 0) > 0 ||
    (projection?.budget.imageUnknownOutstandingMicros ?? 0) > 0;
  const terminationUnknown =
    projection?.statusReason?.endsWith('termination_unconfirmed') === true ||
    Object.values(projection?.executions ?? {}).some(
      (execution) => execution.error?.endsWith('termination_unconfirmed') === true,
    );
  const unknownEffects = effects.filter((effect) => effect.outcome === 'unknown').length;
  const unclearCauses: UnclearCause[] = [
    ...(unknownEffects ? (['effect'] as const) : []),
    ...(budgetUnknown ? (['usage'] as const) : []),
    ...(terminationUnknown ? (['termination'] as const) : []),
  ];
  return {
    failedEffects: effects.filter((effect) => effect.outcome === 'failed').length,
    // A confirmed cancellation is a settled outcome. Unknown effects, unconfirmed cleanup
    // and still-held billing remain actionable even when the run was intentionally stopped.
    unclearEffects: Math.max(unknownEffects, budgetUnknown || terminationUnknown ? 1 : 0),
    unclearCauses,
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

/** What the Usage widget states about a run. Limits are null when none apply. */
export interface UsageSummary {
  spent: number;
  reserved: number;
  unknown: number;
  tokenLimit: number | null;
  calls: number;
  callLimit: number | null;
  /** Output tokens of the latest finished calls with reported usage, oldest first. */
  perCall: number[];
  /** reported input of finished calls; null when none reported it. */
  input: UsageInput | null;
}

export interface UsageInput {
  tokens: number;
  /** Reported cached input; null when no finished call reported it. */
  cached: number | null;
  /** Cached share of the input of calls that reported both figures. */
  cacheShare: number | null;
  /** Finished calls without a cached-input report; never counted as zero. */
  cacheUnreported: number;
}

const PER_CALL_BARS = 12;

export function usageSummary(
  projection: RunProjection | null,
  limits: { maxOutputTokens: number; maxModelCalls: number } | null,
): UsageSummary | null {
  if (!projection) return null;
  const { budget } = projection;
  const perCall = Object.values(projection.modelCalls).flatMap((call) =>
    call.finished && call.usage?.outputTokens != null ? [call.usage.outputTokens] : [],
  );
  if (!budget.modelCalls && !budget.spent && !budget.unknownOutstanding && !perCall.length)
    return null;
  const unlimited = projection.usageLimits === 'none' || !limits;
  return {
    spent: budget.spent,
    reserved: budget.reserved,
    unknown: budget.unknownOutstanding,
    tokenLimit: unlimited ? null : limits.maxOutputTokens,
    calls: budget.modelCalls,
    callLimit: unlimited ? null : limits.maxModelCalls,
    perCall: perCall.slice(-PER_CALL_BARS),
    input: usageInput(projection),
  };
}

function usageInput(projection: RunProjection): UsageInput | null {
  const finished = Object.values(projection.modelCalls).filter((call) => call.finished);
  let tokens = 0;
  let reportedInput = 0;
  let cached = 0;
  let cachedOf = 0;
  let cacheReported = 0;
  for (const call of finished) {
    const input = call.usage?.inputTokens;
    const cache = call.usage?.cachedInputTokens;
    if (input == null) continue;
    tokens += input;
    reportedInput += 1;
    if (cache == null) continue;
    cached += cache;
    cachedOf += input;
    cacheReported += 1;
  }
  if (!reportedInput) return null;
  return {
    tokens,
    cached: cacheReported ? cached : null,
    cacheShare: cacheReported && cachedOf ? cached / cachedOf : null,
    cacheUnreported: finished.filter((call) => call.usage?.cachedInputTokens == null).length,
  };
}

/** the session's statistics under the composer, from each turn's Coordinator usage. */
export interface SessionStats {
  turns: number;
  steps: number;
  tokens: number;
  /** Cached share of input over calls that reported both figures; null when none did. */
  cacheShare: number | null;
  cacheUnreported: number;
}

export function sessionStats(
  projections: readonly RunProjection[],
  steps: (projection: RunProjection) => number,
): SessionStats | null {
  if (!projections.length) return null;
  let tokens = 0;
  let cached = 0;
  let cachedOf = 0;
  let cacheUnreported = 0;
  for (const projection of projections)
    for (const call of Object.values(projection.modelCalls)) {
      if (!call.finished) continue;
      tokens += (call.usage?.inputTokens ?? 0) + (call.usage?.outputTokens ?? 0);
      const input = call.usage?.inputTokens;
      const cache = call.usage?.cachedInputTokens;
      if (input == null || cache == null) {
        cacheUnreported += 1;
        continue;
      }
      cached += cache;
      cachedOf += input;
    }
  return {
    turns: projections.length,
    steps: projections.reduce((sum, projection) => sum + steps(projection), 0),
    tokens,
    cacheShare: cachedOf ? cached / cachedOf : null,
    cacheUnreported,
  };
}

export type OverviewWidget = 'context' | 'usage' | 'results' | 'changes' | 'agents' | 'environment';

/** The Overview's widgets in their fixed order; one with nothing to say is left out. */
export function overviewWidgets(input: {
  chips: readonly WidgetChip[];
  usage: UsageSummary | null;
  results: readonly unknown[];
}): OverviewWidget[] {
  const shown = new Set<OverviewWidget>(input.chips);
  if (input.usage) shown.add('usage');
  if (input.results.length) shown.add('results');
  return (['context', 'usage', 'results', 'changes', 'agents', 'environment'] as const).filter(
    (widget) => shown.has(widget),
  );
}

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
  /** Added and removed lines; null when any file is not counted. */
  additions?: number | null;
  deletions?: number | null;
}):
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | {
      kind: 'count';
      files: number;
      lines: number | null;
      additions: number | null;
      deletions: number | null;
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
    additions: input.additions ?? null,
    deletions: input.deletions ?? null,
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
  if (['created', 'validating'].includes(input.runStatus)) text = 'starting';
  else if (input.needsUser && !terminal) text = 'user';
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

/**
 * The finished run being looked at, and where it sits among the session's runs (#72 IA-13).
 * Only the newest one is the "last" run; an older choice is a selected run, never relabelled.
 */
export function viewedRun(input: {
  runIds: readonly string[];
  presentationRunId: string | null;
  live: boolean;
}): { latest: boolean; number: number; total: number } | null {
  if (!input.presentationRunId || input.live) return null;
  const index = input.runIds.indexOf(input.presentationRunId);
  // A run the session does not list (started elsewhere) has no known order.
  if (index === -1) return { latest: false, number: 0, total: input.runIds.length };
  return {
    latest: index === input.runIds.length - 1,
    number: index + 1,
    total: input.runIds.length,
  };
}
