/** Pure presentation decisions for the chat widgets. No clock, network, or DOM. */
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { canReadArtifactBody, type RunProjection, usageTotals } from '@corral/core';

export function availableResultLinks(
  projection: RunProjection | null,
  items: readonly { artifactVersionId: string; name: string; version: number }[],
) {
  return items
    .filter((item) => canReadArtifactBody(projection, item.artifactVersionId))
    .map((item) => ({ id: item.artifactVersionId, label: `${item.name} v${item.version}` }));
}

/** The tools that write, move or delete a file themselves. */
const FILE_WRITES = new Set([
  'write_file',
  'delete_file',
  'move_file',
  'write',
  'edit',
  'edit_hashline',
]);

/**
 * The finished calls of a run that changed a file, as the run's record knows them. A command may
 * change files too, but the record cannot tell, so it is not counted.
 */
export function fileChangeCount(calls: readonly { name: string; phase?: string }[]) {
  return calls.filter((call) => FILE_WRITES.has(call.name) && call.phase === 'finished').length;
}

/** Shell services can change files after the launch tool has already finished. */
export function fileChangeSignals(
  calls: readonly { name: string; phase?: string }[],
  status: string | undefined,
  live: boolean,
) {
  const mutations = new Set([...FILE_WRITES, 'run_command']);
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
export function workPlanOpen(preference: 'auto' | 'open' | 'closed') {
  // A plan starts as one line (count and current step); the person chooses to expand it.
  return preference === 'open';
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

/** Why an outcome is unclear: an effect, unreported usage, or a stop. */
export type UnclearCause = 'effect' | 'model' | 'usage' | 'termination';

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
  // What a person must answer (chat-widgets-contract §6.3): approvals, questions and results
  // whose outcome is unknown. A failed step is told, but it is not an item to answer or count.
  const answers = [
    input.pendingApprovals ? 'approval' : null,
    input.pendingQuestions ? 'question' : null,
    input.unclearEffects ? 'unclear' : null,
  ].filter((kind): kind is 'approval' | 'question' | 'unclear' => kind !== null);
  return {
    visible: answers.length > 0 || failed > 0,
    needsUser: input.pendingApprovals + input.pendingQuestions > 0,
    hasFailure: failed + input.unclearEffects > 0,
    completedWithFailures: input.runStatus === 'succeeded' && failed > 0,
    count: input.pendingApprovals + input.pendingQuestions + input.unclearEffects,
    summary:
      answers.length === 0
        ? failed
          ? ('failure' as const)
          : ('none' as const)
        : answers.length === 1
          ? answers[0]!
          : ('mixed' as const),
    unclearCauses: input.unclearEffects ? (input.unclearCauses ?? ['effect']) : [],
  };
}

const unclearCopy = {
  effect: 'actionUnclear',
  model: 'actionModelUnknown',
  usage: 'actionUsageUnknown',
  termination: 'actionStopUnconfirmed',
} as const;

/**
 * The attention banner's kit status: a question only asks, so it reads in the info tone; an
 * approval, a failure or an unclear effect keeps the warning.
 */
export function actionTone(action: ReturnType<typeof actionRequired>): 'info' | 'warning' {
  return action.summary === 'question' && !action.hasFailure ? 'info' : 'warning';
}

/** Widgets message keys for the attention banner; several unclear causes are each named. */
export function actionCopy(action: ReturnType<typeof actionRequired>) {
  if (!action.visible) return [];
  if (action.summary === 'approval') return ['actionApproval'] as const;
  if (action.summary === 'question') return ['actionQuestion'] as const;
  if (action.summary === 'failure')
    return [
      action.completedWithFailures ? 'actionCompletedWithFailures' : 'actionFailure',
    ] as const;
  if (action.summary === 'unclear') return action.unclearCauses.map((cause) => unclearCopy[cause]);
  return ['actionMixed'] as const;
}

export function effectAttention(projection: RunProjection | null) {
  const effects = Object.values(projection?.effects ?? {});
  const totals = projection ? usageTotals(projection) : null;
  const usageUnknown = (totals?.unknown ?? 0) > 0 || (totals?.imageCostUnknown ?? 0) > 0;
  const terminationUnknown =
    projection?.statusReason?.endsWith('termination_unconfirmed') === true ||
    Object.values(projection?.executions ?? {}).some(
      (execution) => execution.error?.endsWith('termination_unconfirmed') === true,
    );
  const unknown = effects.filter((effect) => effect.outcome === 'unknown');
  const unknownEffects = unknown.length;
  const unclearCauses: UnclearCause[] = [
    ...(unknown.some((effect) => effect.kind !== 'model_request') ? (['effect'] as const) : []),
    ...(unknown.some((effect) => effect.kind === 'model_request') ? (['model'] as const) : []),
    ...(usageUnknown ? (['usage'] as const) : []),
    ...(terminationUnknown ? (['termination'] as const) : []),
  ];
  return {
    failedEffects: effects.filter((effect) => effect.outcome === 'failed').length,
    // A confirmed cancellation is a settled outcome. Unknown effects, unconfirmed cleanup
    // and unreported usage stay visible even when the run was intentionally stopped.
    unclearEffects: Math.max(unknownEffects, usageUnknown || terminationUnknown ? 1 : 0),
    unclearCauses,
  };
}

/** One current attempt per task; retry history stays in the execution view. */
export function currentAgentExecutions(projection: RunProjection | null) {
  if (!projection) return [];
  const latest = new Map<string, RunProjection['executions'][string]>();
  for (const id of projection.executionOrder) {
    const execution = projection.executions[id];
    if (!execution) continue;
    const previous = latest.get(execution.taskId);
    if (!previous || previous.attemptNo <= execution.attemptNo)
      latest.set(execution.taskId, execution);
  }
  return [...latest.values()].map((last) => {
    const activeId = projection.tasks[last.taskId]?.activeExecutionId;
    const active = activeId ? projection.executions[activeId] : undefined;
    return active?.taskId === last.taskId && active.nodeId === last.nodeId ? active : last;
  });
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
  return executions.length > 1 || working > 0 || waiting > 0 || failed > 0
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

/** The calls of a run as tool rows, each call's effect outcome beside its phase. */
export function runToolRows(projection: RunProjection | null) {
  return toolRows(
    Object.values(projection?.toolCalls ?? {}).map((call) => ({
      toolCallId: call.toolCallId,
      name: call.name,
      phase: call.phase ?? call.status,
      effect: call.effectId ? projection?.effects[call.effectId]?.outcome : null,
    })),
  );
}

/** The execution of the run's first failed tool call: where its failed steps are reviewed. */
export function failedToolExecutionId(
  projection: RunProjection | null,
  rows = runToolRows(projection),
): string | null {
  const id = rows.find((row) => row.tone === 'failed')?.id;
  return (id ? projection?.toolCalls[id]?.executionId : null) ?? null;
}

/**
 * The run's failed execution, for the one way to its detail: the latest execution that ended
 * failed, else the execution of its first failed tool call. None when nothing failed.
 */
export function failedExecutionId(projection: RunProjection | null): string | null {
  const failed = projection?.executionOrder
    .filter((id) => projection.executions[id]?.status === 'failed')
    .at(-1);
  return failed ?? failedToolExecutionId(projection);
}

export type WidgetChip = 'context' | 'environment' | 'agents' | 'changes';

/** What the Usage widget states about a run. Limits are null when none apply. */
export interface UsageSummary {
  /** Output tokens the providers reported. */
  outputTokens: number;
  requests: number;
  /** Requests that ended without reported output usage; never counted as zero. */
  unknown: number;
  /** Output tokens of the latest finished calls with reported usage, oldest first. */
  perCall: number[];
  /** reported input of finished calls; null when none reported it. */
  input: UsageInput | null;
  /** Completed calls without input usage; excluded from the known input total. */
  inputUnreported: number;
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

export function usageSummary(projection: RunProjection | null): UsageSummary | null {
  if (!projection) return null;
  const totals = usageTotals(projection);
  const perCall = Object.values(projection.modelCalls).flatMap((call) =>
    call.finished && call.usage?.outputTokens != null ? [call.usage.outputTokens] : [],
  );
  if (!totals.requests && !perCall.length) return null;
  return {
    outputTokens: totals.outputTokens,
    requests: totals.requests,
    unknown: totals.unknown,
    perCall: perCall.slice(-PER_CALL_BARS),
    input: usageInput(projection),
    inputUnreported: Object.values(projection.modelCalls).filter(
      (call) => call.finished && call.usage?.inputTokens == null,
    ).length,
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

export type OverviewWidget = 'attention' | 'context' | 'usage' | 'results' | 'changes' | 'agents';

/**
 * Put the current task ahead of telemetry, then lead with results after it ends. The execution
 * environment is not a widget: the composer status line and the Run screen state it.
 */
export function overviewWidgets(input: {
  chips: readonly WidgetChip[];
  usage: UsageSummary | null;
  results: readonly unknown[];
  live?: boolean;
  action?: { needsUser: boolean };
}): OverviewWidget[] {
  const shown = new Set<string>(input.chips);
  if (input.action?.needsUser) shown.add('attention');
  if (input.usage) shown.add('usage');
  if (input.results.length) shown.add('results');
  const primary: OverviewWidget[] = input.live
    ? ['attention', 'agents', 'results', 'changes']
    : ['attention', 'results', 'changes', 'agents'];
  return [...primary, 'context' as const, 'usage' as const].filter((widget) => shown.has(widget));
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
  if (
    agents.total > 1 ||
    agents.delegated ||
    agents.working > 0 ||
    agents.waiting > 0 ||
    agents.failed > 0
  )
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

/**
 * Whether the composer's one-line status shows the run's state. A live run's state and controls
 * belong to the top bar's pill, even while it needs the person (the attention notice links to
 * it), so the line shows it only for an ended run and when the state cannot be read.
 */
export function composerShowsRunStatus(input: {
  runStatus: string | null;
  readState: 'empty' | 'loading' | 'ready' | 'error';
}): boolean {
  if (input.readState === 'error') return true;
  return input.runStatus !== null && (TERMINAL_RUN_STATUSES as Set<string>).has(input.runStatus);
}
