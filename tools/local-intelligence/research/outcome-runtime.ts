/** Modeled completed reads, not an observed end-to-end harness trace. No inference. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { requestReasoningInput } from '../../../packages/adapter-pi/src/reasoning-input.ts';
import {
  type EffortInput,
  formatDecisionPrompt,
  renderEffort,
  toEffortInput,
} from '../../../packages/local-intelligence/src/decision/text.ts';
import { effortText } from '../../../packages/local-intelligence/src/effort/preprocess.ts';

const SCOPE = 'modeled-completed-read-snapshot';

export interface OutcomeSource {
  task: 'effort';
  input: EffortInput;
}

function validate(input: EffortInput) {
  if (!input || typeof input.request !== 'string' || input.stage !== 'step')
    throw new Error('outcome input must be a modeled step');
  const supported = new Set([
    'request',
    'stage',
    'tools',
    'goal',
    'previousRequest',
    'previousReply',
    'plan',
  ]);
  if (Object.keys(input).some((key) => !supported.has(key)))
    throw new Error('unsupported outcome input field');
  for (const value of [input.goal, input.previousRequest, input.previousReply, input.plan])
    if (value !== undefined && value !== null && value !== '')
      throw new Error('unsupported nonempty outcome context');
  if (!Array.isArray(input.tools) || input.tools.length === 0)
    throw new Error('outcome input requires supplied reads');
  for (const tool of input.tools) {
    if (
      tool?.name !== 'read_file' ||
      typeof tool.args !== 'string' ||
      typeof tool.content !== 'string' ||
      !['success', 'completed'].includes(tool.status) ||
      Object.keys(tool).some((key) => !['name', 'args', 'status', 'content'].includes(key))
    )
      throw new Error('outcome input requires completed read_file results');
  }
  return input.tools;
}

/** The renderer reads task/input only; targets and other record metadata stay opaque. */
export function deriveOutcomeRuntime(row: OutcomeSource) {
  if (
    row.task !== 'effort' ||
    Object.hasOwn(row, 'runtimeView') ||
    Object.hasOwn(row, 'coreReasoningInput')
  )
    throw new Error('outcome source is invalid or already derived');
  const tools = validate(row.input);
  const context = {
    messages: [
      { role: 'user', content: row.input.request, timestamp: 0 },
      {
        role: 'assistant',
        timestamp: 1,
        content: tools.map((tool, i) => ({
          type: 'toolCall',
          id: `source${i + 1}`,
          name: tool.name,
          // v2 stores the source path, not an encoded SDK arguments object.
          arguments: { path: tool.args },
        })),
      },
      ...tools.map((tool, i) => ({
        role: 'toolResult',
        toolCallId: `source${i + 1}`,
        toolName: tool.name,
        content: [{ type: 'text', text: tool.content }],
        isError: false,
        timestamp: i + 2,
      })),
    ],
  } as Parameters<typeof requestReasoningInput>[0];
  const coreReasoningInput = requestReasoningInput(context, 'step', '', []);
  const runtimeText = renderEffort(toEffortInput(coreReasoningInput));
  return {
    coreReasoningInput,
    runtimeView: {
      scope: SCOPE,
      runtimeText,
      legacyText: effortText(coreReasoningInput),
      prompt: formatDecisionPrompt('effort', runtimeText),
      participantIds: [] as string[],
      modelToOriginalIds: {} as Record<string, string>,
    },
  };
}

function outsideRepository(path: string) {
  let at = dirname(path);
  while (!existsSync(at)) at = dirname(at);
  at = realpathSync(at);
  for (;;) {
    if (existsSync(join(at, '.git'))) throw new Error('outcome data must stay private');
    if (at === dirname(at)) return;
    at = dirname(at);
  }
}

function readPrivate(path: string) {
  const actual = realpathSync(resolve(path));
  outsideRepository(actual);
  return readFileSync(actual, 'utf8');
}

/** Preserve original field bytes by appending to each outer JSON object. */
export function writeOutcomeRuntime(sourcePath: string, outputPath: string, v2Path?: string) {
  const original = readPrivate(sourcePath);
  const output = resolve(outputPath);
  outsideRepository(output);
  if (existsSync(output)) throw new Error('outcome output must be new');
  const v2 = v2Path ? readPrivate(v2Path) : undefined;
  const baseline = new Map<string, string>();
  if (v2 !== undefined) {
    for (const line of v2.split('\n').filter((line) => line.trim())) {
      const row = JSON.parse(line);
      if (
        row.task !== 'effort' ||
        typeof row.id !== 'string' ||
        typeof row.text !== 'string' ||
        baseline.has(row.id)
      )
        throw new Error('v2 comparison rows are invalid');
      baseline.set(row.id, row.text);
    }
  }
  let rowCount = 0;
  let exactV2PromptMatchCount = 0;
  const compared = new Set<string>();
  const derived = original
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      const row = JSON.parse(line);
      const view = deriveOutcomeRuntime(row);
      let v2Text = renderEffort(row.input);
      if (v2 !== undefined) {
        const text = baseline.get(row.id);
        if (text === undefined || compared.has(row.id)) throw new Error('v2 comparison IDs differ');
        compared.add(row.id);
        v2Text = text;
      }
      if (view.runtimeView.prompt === formatDecisionPrompt('effort', v2Text))
        exactV2PromptMatchCount++;
      rowCount++;
      const at = line.lastIndexOf('}');
      return `${line.slice(0, at)},"coreReasoningInput":${JSON.stringify(view.coreReasoningInput)},"runtimeView":${JSON.stringify(view.runtimeView)}${line.slice(at)}`;
    })
    .join('\n');
  if (!rowCount || (v2 !== undefined && compared.size !== baseline.size))
    throw new Error('outcome source and comparison rows differ');
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, derived, { flag: 'wx', mode: 0o600 });
  return {
    scope: SCOPE,
    rowCount,
    exactV2PromptMatchCount,
    comparison: v2 === undefined ? 'raw-v2-shared-renderer' : 'provided-v2-text',
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    ...(v2 === undefined ? {} : { v2Sha256: createHash('sha256').update(v2).digest('hex') }),
    outputSha256: createHash('sha256').update(derived).digest('hex'),
  };
}

if (import.meta.main) {
  const [source, output, v2, ...extra] = process.argv.slice(2);
  if (!source || !output || extra.length) {
    console.error(
      'Usage: outcome-runtime.ts <private-raw.jsonl> <new-output.jsonl> [private-v2-inputs.jsonl]',
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(writeOutcomeRuntime(source, output, v2)));
    } catch {
      console.error('outcome runtime derivation failed; check private input and new output');
      process.exitCode = 1;
    }
  }
}
