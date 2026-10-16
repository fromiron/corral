import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CorralDefinition } from '@corral/contracts';
import {
  compileDefinition,
  type RunProjection,
  type RuntimeTransport,
  waitForProjection,
} from '@corral/core';

// Headless runs and the variant comparison harness (roadmap Core-③, Spec §1.3 and §12).
// A headless run never decides for a person: when it would wait for an approval it is cancelled
// and reported as needing a person.

const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export interface ExecResult {
  runId: string;
  status: string;
  /** The run reached a point only a person may decide; it was cancelled instead of waiting. */
  needsUser: boolean;
  reason: string | null;
  output: string | null;
  wallMs: number;
  modelCalls: number;
  outputTokens: number;
  unknownTokensHeld: number;
  executions: number;
  /** reasoning_effort judgments by provider: answer → count (observe only). */
  judgments: Record<string, Record<string, number>>;
}

let commands = 0;
const commandId = () => `cmd_exec_${Date.now().toString(36)}_${++commands}`;

export async function executeOnce(
  transport: RuntimeTransport,
  definition: CorralDefinition,
  mode: 'mock' | 'live',
  { signal, now = () => performance.now() }: { signal: AbortSignal; now?: () => number },
): Promise<ExecResult> {
  const started = now();
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: commandId(),
    definition,
    mode,
  });
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
  let projection: RunProjection;
  let needsUser = false;
  try {
    projection = await waitForProjection(
      transport,
      runId,
      (p) => ENDED.has(p.status) || p.status === 'awaiting_user',
    );
    if (projection.status === 'awaiting_user') {
      needsUser = true;
      await cancel('headless run needs a person: no automatic approval');
      projection = await waitForProjection(transport, runId, (p) => ENDED.has(p.status));
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const texts = await Promise.all(
    (projection.output?.artifactVersionIds ?? []).map((id) => transport.getArtifactText(runId, id)),
  );
  const judgments: ExecResult['judgments'] = {};
  for (const d of Object.values(projection.decisions ?? {})) {
    const byAnswer = judgments[d.provider] ?? {};
    const key = d.status === 'observed' ? (d.answer ?? 'unknown') : d.status;
    byAnswer[key] = (byAnswer[key] ?? 0) + 1;
    judgments[d.provider] = byAnswer;
  }
  return {
    runId,
    status: projection.status,
    needsUser,
    reason: projection.statusReason,
    output: texts.some((t) => t !== null) ? texts.filter((t) => t !== null).join('\n\n') : null,
    wallMs: Math.round(now() - started),
    modelCalls: projection.budget.modelCalls,
    outputTokens: projection.budget.spent,
    unknownTokensHeld: projection.budget.unknownOutstanding,
    executions: projection.executionOrder.length,
    judgments,
  };
}

export interface EvalSuite {
  briefs: { id: string; brief: string }[];
  variants: { id: string; corral: string; definition: CorralDefinition }[];
}

/** Reads and checks a suite file; every problem is reported before anything runs. */
export function loadSuite(
  path: string,
): { ok: true; suite: EvalSuite } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let raw: { schemaVersion?: unknown; briefs?: unknown; variants?: unknown };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, errors: [`${path} is not valid JSON`] };
  }
  if (raw.schemaVersion !== '0.1') errors.push('schemaVersion must be "0.1"');
  const briefs = Array.isArray(raw.briefs)
    ? (raw.briefs as { id?: unknown; brief?: unknown }[])
    : [];
  const variants = Array.isArray(raw.variants)
    ? (raw.variants as { id?: unknown; corral?: unknown }[])
    : [];
  if (briefs.length === 0) errors.push('briefs must list at least one brief');
  if (variants.length === 0) errors.push('variants must list at least one variant');
  const seen = (kind: string) => {
    const ids = new Set<string>();
    return (id: unknown) => {
      if (typeof id !== 'string' || !id) errors.push(`every ${kind} needs an id`);
      else if (ids.has(id)) errors.push(`duplicate ${kind} id ${id}`);
      else ids.add(id);
    };
  };
  const briefId = seen('brief');
  for (const b of briefs) {
    briefId(b.id);
    if (typeof b.brief !== 'string' || !b.brief.trim())
      errors.push(`brief ${String(b.id)} is empty`);
  }
  const variantId = seen('variant');
  const loaded: EvalSuite['variants'] = [];
  for (const v of variants) {
    variantId(v.id);
    const file = typeof v.corral === 'string' ? resolve(dirname(path), v.corral) : '';
    if (!file || !existsSync(file)) {
      errors.push(`variant ${String(v.id)}: ${String(v.corral)} not found`);
      continue;
    }
    const compiled = compileDefinition(JSON.parse(readFileSync(file, 'utf8')));
    if (!compiled.ok) {
      errors.push(
        `variant ${String(v.id)}: invalid Corral (${compiled.diagnostics.map((d) => d.code).join(', ')})`,
      );
      continue;
    }
    loaded.push({ id: String(v.id), corral: String(v.corral), definition: compiled.definition });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    suite: {
      briefs: briefs.map((b) => ({ id: String(b.id), brief: String(b.brief) })),
      variants: loaded,
    },
  };
}

export interface EvalReport {
  mode: 'mock' | 'live';
  results: (ExecResult & { variant: string; brief: string })[];
  summary: {
    variant: string;
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
  options: { signal: AbortSignal; onResult?: (line: string) => void },
): Promise<EvalReport> {
  const results: EvalReport['results'] = [];
  for (const brief of suite.briefs) {
    for (const variant of suite.variants) {
      if (options.signal.aborted) break;
      const definition = structuredClone(variant.definition);
      definition.input = { ...definition.input, brief: brief.brief };
      const result = await executeOnce(transport, definition, mode, options);
      results.push({ ...result, variant: variant.id, brief: brief.id });
      options.onResult?.(
        `${variant.id} × ${brief.id}: ${result.status} · ${result.modelCalls} calls`,
      );
    }
  }
  const summary = suite.variants.map((variant) => {
    const rows = results.filter((r) => r.variant === variant.id);
    return {
      variant: variant.id,
      runs: rows.length,
      succeeded: rows.filter((r) => r.status === 'succeeded').length,
      needsUser: rows.filter((r) => r.needsUser).length,
      failed: rows.filter((r) => r.status !== 'succeeded' && !r.needsUser).length,
      meanModelCalls: mean(rows.map((r) => r.modelCalls)),
      meanOutputTokens: mean(rows.map((r) => r.outputTokens)),
      meanWallMs: mean(rows.map((r) => r.wallMs)),
      meanExecutions: mean(rows.map((r) => r.executions)),
    };
  });
  return { mode, results, summary };
}

/** The summary as a Markdown table. It measures cost and time, not answer quality. */
export function summaryTable(report: EvalReport): string {
  const head =
    '| variant | runs | succeeded | needs a person | failed | model calls | output tokens | wall ms | executions |';
  const rule = '|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const rows = report.summary.map(
    (s) =>
      `| ${s.variant} | ${s.runs} | ${s.succeeded} | ${s.needsUser} | ${s.failed} | ${s.meanModelCalls} | ${s.meanOutputTokens} | ${s.meanWallMs} | ${s.meanExecutions} |`,
  );
  return [head, rule, ...rows].join('\n');
}
