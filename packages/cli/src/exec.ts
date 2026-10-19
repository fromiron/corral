import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type CorralDefinition,
  canonicalJson,
  type EvalExpectation,
  EvalSuiteDocument,
  type EvalSuiteGroup,
  type EventOf,
  UserAnswerFile,
  UserInputRequest,
  validUserAnswers,
} from '@corral/contracts';
import {
  type AutoStart,
  type Coordinator,
  compileDefinition,
  createAutoStarter,
  type RunProjection,
  type RuntimeTransport,
  waitForProjection,
} from '@corral/core';

// Headless runs and the variant comparison harness (roadmap Core-③, Spec §1.3 and §12).
// A headless run never decides for a person: when it would wait for an approval it is cancelled
// and reported as needing a person. User questions instead return a needs_input record.
// The owner of the runtime remains responsible for shutdown or further answers.

const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export interface ExecResult {
  runId: string;
  status: string;
  /** The run reached a point only a person may decide; it was cancelled instead of waiting. */
  needsUser: boolean;
  /** Private question bodies for the caller; never included in public events. */
  pendingInput?: {
    requestId: string;
    executionId: string;
    attemptNo: number;
    schemaHash: string;
    deadline: string;
    request: UserInputRequest;
  }[];
  reason: string | null;
  output: string | null;
  wallMs: number;
  modelCalls: number;
  outputTokens: number;
  unknownTokensHeld: number;
  executions: number;
  candidateOutput: string | null;
  definitionHash: string | null;
  metricsComplete: boolean;
  modelRetries: number | null;
  executionRestarts: number;
  repairRounds: number;
  humanRequests: number | null;
  harnessHashes: string[];
  recipeHashes: string[];
  toolsExecuted: string[];
  inputTokens: number | null;
  skillEvidence: {
    bound: string[];
    read: string[];
    delivered: string[] | null;
    payloads: number | null;
    payloadBytes: number | null;
    procedureAdherence: null;
  };
  /** reasoning_effort judgments by provider: answer → count (observe only). */
  judgments: Record<string, Record<string, number>>;
}

let commands = 0;
const commandId = () => `cmd_exec_${Date.now().toString(36)}_${++commands}`;

export async function executeOnce(
  transport: RuntimeTransport,
  definition: CorralDefinition,
  mode: 'mock' | 'live',
  {
    signal,
    sessionId,
    answers = [],
    auto,
    resolveUltra,
    wallNow = Date.now,
    now = () => performance.now(),
  }: {
    signal: AbortSignal;
    auto?: Pick<AutoStart, 'choice' | 'qualityPreset' | 'ultra'>;
    resolveUltra?: Coordinator['resolveUltra'];
    sessionId?: string;
    now?: () => number;
    wallNow?: () => number;
    answers?: UserAnswerFile;
  },
): Promise<ExecResult> {
  signal.throwIfAborted();
  const supplied = UserAnswerFile.parse(answers);
  const started = now();
  const start = {
    schemaVersion: '0.1' as const,
    commandId: commandId(),
    definition,
    mode,
    ...(sessionId ? { sessionId } : {}),
  };
  const { runId, receipt } = auto
    ? await createAutoStarter({
        startRun: (request) => transport.startRun(request),
        ...(resolveUltra ? { resolveUltra } : {}),
      }).start(
        {
          ...auto,
          commandId: start.commandId,
          brief: definition.input.brief,
          criteria: definition.input.criteria,
          mode,
          ...(sessionId ? { sessionId } : {}),
        },
        { fileTools: false, signal },
      )
    : await transport.startRun(start);
  if (!runId)
    throw new Error(
      `run refused: ${receipt.error?.code ?? 'UNKNOWN'} ${receipt.error?.message ?? ''}`,
    );
  const cancel = (reason: string) =>
    transport.sendCommand({
      schemaVersion: '0.1',
      commandId: commandId(),
      runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason },
    });
  const onAbort = () => void cancel('interrupted by the user').catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  let projection: RunProjection;
  let needsUser = false;
  let pendingInput: ExecResult['pendingInput'];
  const pendingQuestions = new Map<string, EventOf<'user_input.requested'>>();
  let observedSeq = 0,
    targetSeq = Number.POSITIVE_INFINITY,
    metricsFailed = false,
    wake = () => {};
  let modelRetries = 0,
    humanRequests = 0;
  const harnessHashes = new Set<string>(),
    recipeHashes = new Set<string>(),
    toolsExecuted = new Set<string>(),
    toolNames = new Map<string, string>();
  const boundSkills = new Set<string>(),
    readSkills = new Set<string>(),
    deliveredSkills = new Set<string>();
  let payloads = 0,
    payloadBytes = 0,
    measuredPayloads = 0;
  const offMetrics = transport.subscribe(runId, 0, {
    onEvent(event) {
      if (event.runSeq <= observedSeq) return;
      observedSeq = event.runSeq;
      if (event.type === 'model.request_recorded' && event.payload.purpose === 'retry')
        modelRetries += 1;
      if (event.type === 'user_input.requested')
        pendingQuestions.set(event.payload.requestId, event);
      if (event.type === 'user_input.answered' || event.type === 'user_input.closed')
        pendingQuestions.delete(event.payload.requestId);
      if (
        event.type === 'user_input.requested' ||
        event.type === 'approval.requested' ||
        event.type === 'extension.ui_requested'
      )
        humanRequests += 1;
      if (event.type === 'run.started')
        for (const harness of Object.values(event.payload.harnesses ?? {})) {
          harnessHashes.add(harness.snapshotHash);
          for (const resource of harness.resources)
            if (resource.kind === 'skill' && resource.skillName)
              boundSkills.add(resource.skillName);
        }
      if (event.type === 'skill.read') readSkills.add(event.payload.skillName);
      if (event.type === 'model.payload_recorded') {
        payloads++;
        payloadBytes += event.payload.payloadBytes;
        if (event.payload.skills) {
          measuredPayloads++;
          for (const skill of event.payload.skills) deliveredSkills.add(skill.name);
        }
      }
      if (event.type === 'recipe.evaluated' || event.type === 'recipe.stopped')
        recipeHashes.add(event.payload.recipeHash);
      if (event.type === 'tool.requested')
        toolNames.set(event.payload.toolCallId, event.payload.name);
      if (event.type === 'tool.started') {
        const name = toolNames.get(event.payload.toolCallId);
        if (name) toolsExecuted.add(name);
      }
      if (observedSeq >= targetSeq) wake();
    },
    onError() {
      metricsFailed = true;
      wake();
    },
  });
  try {
    for (;;) {
      projection = await waitForProjection(
        transport,
        runId,
        (p) => ENDED.has(p.status) || p.status === 'awaiting_user',
      );
      targetSeq = projection.lastSeq;
      if (observedSeq < targetSeq && !metricsFailed)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      if (projection.status !== 'awaiting_user') break;
      if (pendingQuestions.size) {
        pendingInput = [];
        for (const event of pendingQuestions.values()) {
          const body = await transport.getArtifactText(runId, event.payload.bodyRef);
          if (!body) throw new Error('the private user question is unavailable');
          const request = UserInputRequest.parse(JSON.parse(body));
          const { requestId, executionId, attemptNo, schemaHash, deadline } = event.payload;
          pendingInput.push({ requestId, executionId, attemptNo, schemaHash, deadline, request });
        }
        const pending = pendingInput[0];
        const answer =
          pending &&
          supplied.find(
            (a) => a.key === pending.request.key && a.schemaHash === pending.schemaHash,
          );
        if (
          pending &&
          answer &&
          Date.parse(pending.deadline) > wallNow() &&
          validUserAnswers(pending.request, answer.answers)
        ) {
          const receipt = await transport.sendCommand({
            schemaVersion: '0.1',
            commandId: commandId(),
            runId,
            type: 'answer_user',
            expectedControlRevision: projection.controlRevision,
            payload: {
              requestId: pending.requestId,
              executionId: pending.executionId,
              attemptNo: pending.attemptNo,
              schemaHash: pending.schemaHash,
              answers: answer.answers,
            },
          });
          if (receipt.status === 'applied') {
            pendingInput = undefined;
            continue;
          }
        }
        needsUser = true;
        break;
      }
      needsUser = true;
      await cancel('headless run needs a person: no automatic approval');
      projection = await waitForProjection(transport, runId, (p) => ENDED.has(p.status));
      break;
    }
    targetSeq = projection.lastSeq;
    if (observedSeq < targetSeq && !metricsFailed)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
  } finally {
    signal.removeEventListener('abort', onAbort);
    offMetrics();
  }
  const texts = await Promise.all(
    (projection.output?.artifactVersionIds ?? []).map((id) => transport.getArtifactText(runId, id)),
  );
  const judgments: ExecResult['judgments'] = {};
  const recipeNode = definition.nodes.find((node) => node.type === 'loop' && node.reviewRecipe);
  const candidates =
    recipeNode?.type === 'loop' && recipeNode.reviewRecipe
      ? [recipeNode.reviewRecipe.candidateNodeId]
      : definition.nodes.flatMap((node) =>
          node.type === 'output'
            ? node.inputBindings.flatMap((binding) =>
                binding.kind === 'task_output' && binding.sourceNodeId
                  ? [binding.sourceNodeId]
                  : [],
              )
            : [],
        );
  const candidateIds = [
    ...new Set(
      candidates.flatMap((nodeId) => {
        const executionId = projection.nodeExecutions[nodeId]?.at(-1);
        if (!executionId) return [];
        const execution = projection.executions[executionId];
        const submitted = execution
          ? projection.tasks[execution.taskId]?.submittedArtifactVersionIds
          : undefined;
        return submitted?.length
          ? submitted
          : Object.values(projection.artifacts)
              .filter((artifact) => artifact.authorExecutionId === executionId)
              .slice(-1)
              .map((artifact) => artifact.artifactVersionId);
      }),
    ),
  ];
  const candidateTexts = await Promise.all(
    candidateIds.map((id) => transport.getArtifactText(runId, id)),
  );
  for (const d of Object.values(projection.decisions ?? {})) {
    const byAnswer = judgments[d.provider] ?? {};
    const key = d.status === 'observed' ? (d.answer ?? 'unknown') : d.status;
    byAnswer[key] = (byAnswer[key] ?? 0) + 1;
    judgments[d.provider] = byAnswer;
  }
  return {
    runId,
    status: pendingInput ? 'needs_input' : projection.status,
    ...(pendingInput ? { pendingInput } : {}),
    needsUser,
    reason: projection.statusReason,
    output: texts.some((t) => t !== null) ? texts.filter((t) => t !== null).join('\n\n') : null,
    wallMs: Math.round(now() - started),
    modelCalls: projection.budget.modelCalls,
    outputTokens: projection.budget.spent,
    unknownTokensHeld: projection.budget.unknownOutstanding,
    executions: projection.executionOrder.length,
    candidateOutput: candidateTexts.some((text) => text !== null)
      ? candidateTexts.filter((text) => text !== null).join('\n\n')
      : null,
    definitionHash: projection.definitionHash,
    metricsComplete: !metricsFailed && observedSeq >= targetSeq,
    modelRetries: metricsFailed ? null : modelRetries,
    executionRestarts: Object.values(projection.executions).filter(
      (execution) => execution.attemptNo > 1,
    ).length,
    repairRounds: Object.values(projection.loopIterations).reduce(
      (count, iterations) => count + Math.max(0, iterations.length - 1),
      0,
    ),
    humanRequests: metricsFailed ? null : humanRequests,
    harnessHashes: [...harnessHashes],
    recipeHashes: [...recipeHashes],
    toolsExecuted: [...toolsExecuted],
    inputTokens:
      Object.values(projection.modelCalls).length &&
      Object.values(projection.modelCalls).every(
        (call) => call.certainty === 'reported' && call.usage?.inputTokens != null,
      )
        ? Object.values(projection.modelCalls).reduce(
            (sum, call) => sum + call.usage!.inputTokens!,
            0,
          )
        : null,
    skillEvidence: {
      bound: [...boundSkills].sort(),
      read: [...readSkills].sort(),
      delivered:
        !metricsFailed &&
        observedSeq >= targetSeq &&
        measuredPayloads > 0 &&
        measuredPayloads === Object.keys(projection.modelCalls).length
          ? [...deliveredSkills].sort()
          : null,
      payloads: metricsFailed ? null : payloads,
      payloadBytes: metricsFailed || !payloads ? null : payloadBytes,
      procedureAdherence: null,
    },
    judgments,
  };
}

export interface EvalSuite {
  comparison?: EvalSuiteDocument['comparison'];
  repetitions?: EvalSuiteDocument['repetitions'];
  workspace?: EvalSuiteDocument['workspace'];
  briefs: EvalSuiteDocument['briefs'];
  variants: (EvalSuiteDocument['variants'][number] & { definition: CorralDefinition })[];
}

/** Reads and checks a suite file; every problem is reported before anything runs. */
export function loadSuite(
  path: string,
): { ok: true; suite: EvalSuite } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let document: EvalSuiteDocument;
  try {
    if (statSync(path).size > 4 * 1024 * 1024)
      return { ok: false, errors: ['suite exceeds 4 MiB'] };
    const parsed = EvalSuiteDocument.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success)
      return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
    document = parsed.data;
  } catch {
    return { ok: false, errors: ['suite is not valid JSON'] };
  }
  const loaded: EvalSuite['variants'] = [];
  for (const variant of document.variants) {
    const file = resolve(dirname(path), variant.corral);
    if (!existsSync(file)) {
      errors.push(`variant ${variant.id}: Corral file not found`);
      continue;
    }
    try {
      if (statSync(file).size > 4 * 1024 * 1024) throw new Error('oversized');
      const compiled = compileDefinition(JSON.parse(readFileSync(file, 'utf8')));
      if (!compiled.ok) {
        errors.push(
          `variant ${variant.id}: invalid Corral (${compiled.diagnostics.map((diagnostic) => diagnostic.code).join(', ')})`,
        );
        continue;
      }
      loaded.push({ ...variant, definition: compiled.definition });
    } catch {
      errors.push(`variant ${variant.id}: invalid Corral JSON`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    suite: {
      ...(document.comparison ? { comparison: document.comparison } : {}),
      ...(document.repetitions !== undefined ? { repetitions: document.repetitions } : {}),
      ...(document.workspace ? { workspace: document.workspace } : {}),
      briefs: document.briefs,
      variants: loaded,
    },
  };
}

export interface QualityResult {
  finalCorrect: boolean;
  candidateCorrect: boolean | null;
  falsePass: boolean;
  unnecessaryRejection: boolean | null;
}
function matchesExpected(text: string, expected: EvalExpectation): boolean {
  if (expected.kind === 'exact') return text === expected.text;
  if (expected.kind === 'includes') return expected.all.every((part) => text.includes(part));
  try {
    return canonicalJson(JSON.parse(text)) === canonicalJson(expected.value);
  } catch {
    return false;
  }
}
function qualityOf(
  result: ExecResult,
  expected: EvalExpectation | undefined,
): QualityResult | null {
  if (!expected) return null;
  const finalCorrect =
    result.status === 'succeeded' &&
    result.output !== null &&
    matchesExpected(result.output, expected);
  const candidateCorrect =
    result.candidateOutput === null ? null : matchesExpected(result.candidateOutput, expected);
  const rejected = ['attempt_limit', 'repair_limit', 'repeated_output', 'repeated_failure'].some(
    (reason) => result.reason === `review_recipe:${reason}`,
  );
  return {
    finalCorrect,
    candidateCorrect,
    falsePass: result.status === 'succeeded' && !finalCorrect,
    unnecessaryRejection:
      result.needsUser || (result.status !== 'succeeded' && !rejected) || candidateCorrect === null
        ? null
        : rejected && candidateCorrect,
  };
}

export interface EvalReport {
  mode: 'mock' | 'live';
  comparison?: EvalSuite['comparison'];
  repetitions: number;
  results: (ExecResult & {
    variant: string;
    brief: string;
    phase: 'calibration' | 'holdout';
    group?: EvalSuiteGroup;
    repetition: number;
    quality: QualityResult | null;
    activation: { missing: string[]; forbidden: string[]; passed: boolean } | null;
    workspace?: { sessionId: string; baseCommit: string };
  })[];
  summary: {
    variant: string;
    phase: 'calibration' | 'holdout';
    group?: EvalSuiteGroup;
    quality: {
      expectedRuns: number;
      finalCorrect: number;
      finalAccuracy: number | null;
      falsePasses: number;
      unnecessaryRejections: number;
    };
    activation: { measuredRuns: number; failedRuns: number; missing: number; forbidden: number };
    meanModelRetries: number | null;
    meanExecutionRestarts: number;
    meanRepairRounds: number;
    humanRequests: number | null;
    runs: number;
    succeeded: number;
    needsUser: number;
    failed: number;
    meanModelCalls: number;
    meanOutputTokens: number;
    meanWallMs: number;
    meanExecutions: number;
  }[];
}

const mean = (values: number[]) =>
  values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : 0;

/** Every variant on every brief, one run at a time (one active run per workspace). */
export async function runSuite(
  transport: RuntimeTransport,
  suite: EvalSuite,
  mode: 'mock' | 'live',
  options: {
    signal: AbortSignal;
    onResult?: (line: string) => void;
    prepareWorkspace?: (
      target: NonNullable<EvalSuite['workspace']>,
    ) => Promise<{ sessionId: string; baseCommit: string }>;
  },
): Promise<EvalReport> {
  if (suite.workspace && !options.prepareWorkspace)
    throw new Error('evaluation workspace provider is required');
  const results: EvalReport['results'] = [];
  const repetitions = suite.repetitions ?? 1;
  cases: for (const brief of suite.briefs) {
    for (const variant of suite.variants) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        if (options.signal.aborted) break cases;
        const definition = structuredClone(variant.definition);
        definition.input = { ...definition.input, brief: brief.brief };
        const workspace = suite.workspace
          ? await options.prepareWorkspace!(suite.workspace)
          : undefined;
        if (workspace && workspace.baseCommit !== suite.workspace?.baseCommit)
          throw new Error('evaluation workspace does not match the pinned commit');
        const result = await executeOnce(transport, definition, mode, {
          ...options,
          ...(workspace ? { sessionId: workspace.sessionId } : {}),
        });
        const delivered = result.skillEvidence.delivered;
        const missing =
          brief.skillExpectation && delivered
            ? brief.skillExpectation.required.filter((name) => !delivered.includes(name))
            : [];
        const forbidden =
          brief.skillExpectation && delivered
            ? brief.skillExpectation.forbidden.filter((name) => delivered.includes(name))
            : [];
        results.push({
          ...result,
          ...(workspace ? { workspace } : {}),
          variant: variant.id,
          repetition,
          brief: brief.id,
          phase: brief.phase ?? 'holdout',
          ...(variant.group ? { group: variant.group } : {}),
          quality: qualityOf(result, brief.expected),
          activation:
            brief.skillExpectation && delivered
              ? { missing, forbidden, passed: !missing.length && !forbidden.length }
              : null,
        });
        options.onResult?.(
          `${variant.id} × ${brief.id}: ${result.status} · ${result.modelCalls} calls`,
        );
      }
    }
  }
  const summary = suite.variants.flatMap((variant) =>
    [...new Set(suite.briefs.map((brief) => brief.phase ?? 'holdout'))].map((phase) => {
      const rows = results.filter((r) => r.variant === variant.id && r.phase === phase);
      const scored = rows.flatMap((row) => (row.quality ? [row.quality] : [])),
        finalCorrect = scored.filter((row) => row.finalCorrect).length;
      const activations = rows.flatMap((row) => (row.activation ? [row.activation] : []));
      return {
        variant: variant.id,
        phase,
        ...(variant.group ? { group: variant.group } : {}),
        quality: {
          expectedRuns: scored.length,
          finalCorrect,
          finalAccuracy: scored.length ? finalCorrect / scored.length : null,
          falsePasses: scored.filter((row) => row.falsePass).length,
          unnecessaryRejections: scored.filter((row) => row.unnecessaryRejection).length,
        },
        activation: {
          measuredRuns: activations.length,
          failedRuns: activations.filter((row) => !row.passed).length,
          missing: activations.reduce((sum, row) => sum + row.missing.length, 0),
          forbidden: activations.reduce((sum, row) => sum + row.forbidden.length, 0),
        },
        meanModelRetries: rows.some((row) => row.modelRetries === null)
          ? null
          : mean(rows.map((row) => row.modelRetries ?? 0)),
        meanExecutionRestarts: mean(rows.map((row) => row.executionRestarts)),
        meanRepairRounds: mean(rows.map((row) => row.repairRounds)),
        humanRequests: rows.some((row) => row.humanRequests === null)
          ? null
          : rows.reduce((count, row) => count + (row.humanRequests ?? 0), 0),
        runs: rows.length,
        succeeded: rows.filter((r) => r.status === 'succeeded').length,
        needsUser: rows.filter((r) => r.needsUser).length,
        failed: rows.filter((r) => r.status !== 'succeeded' && !r.needsUser).length,
        meanModelCalls: mean(rows.map((r) => r.modelCalls)),
        meanOutputTokens: mean(rows.map((r) => r.outputTokens)),
        meanWallMs: mean(rows.map((r) => r.wallMs)),
        meanExecutions: mean(rows.map((r) => r.executions)),
      };
    }),
  );
  return {
    mode,
    ...(suite.comparison ? { comparison: suite.comparison } : {}),
    repetitions,
    results,
    summary,
  };
}

/** Costs and oracle-scored quality stay separate; calibration never joins holdout. */
export function summaryTable(report: EvalReport): string {
  const head =
    '| variant | phase | runs | succeeded | needs a person | failed | model calls | output tokens | wall ms | executions |';
  const rule = '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const rows = report.summary.map(
    (s) =>
      `| ${s.variant} | ${s.phase} | ${s.runs} | ${s.succeeded} | ${s.needsUser} | ${s.failed} | ${s.meanModelCalls} | ${s.meanOutputTokens} | ${s.meanWallMs} | ${s.meanExecutions} |`,
  );
  const quality = report.summary.some((row) => row.quality.expectedRuns)
    ? [
        '',
        '| variant | phase | expected tasks | final accuracy | false passes | unnecessary rejections | retries | restarts | repairs | human requests |',
        '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
        ...report.summary.map(
          (row) =>
            `| ${row.variant} | ${row.phase} | ${row.quality.expectedRuns} | ${row.quality.finalAccuracy === null ? 'unmeasured' : `${(row.quality.finalAccuracy * 100).toFixed(1)}%`} | ${row.quality.falsePasses} | ${row.quality.unnecessaryRejections} | ${row.meanModelRetries ?? 'unknown'} | ${row.meanExecutionRestarts} | ${row.meanRepairRounds} | ${row.humanRequests ?? 'unknown'} |`,
        ),
      ]
    : [];
  return [head, rule, ...rows, ...quality].join('\n');
}
