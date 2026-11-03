// The judgment text for an effort decision: a copy of the request input, never the model's own
// context. The current request comes first because the engine keeps only the first 256 tokens;
// then the plan, the most recent tool calls, and the earlier turn. Changing anything here changes
// the embeddings the classifier was trained on, so it needs a new version and new weights.
import type { ReasoningInput } from '@corral/contracts';

export const EFFORT_PREPROCESS_VERSION = 'effort-text-v1';

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are stripped from tool output
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function clean(text: string): string {
  return text
    .replace(ESCAPES, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function head(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}

function tail(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(-max).join('');
}

function result(text: string): string {
  return [...text].length <= 360 ? text : `${head(text, 240)} … ${tail(text, 120)}`;
}

/** A judgment input that has only the request text, as the observe path and training see it. */
export function requestInput(request: string): ReasoningInput {
  return {
    kind: 'turn',
    request,
    prevRequest: '',
    prev: '',
    step: 0,
    plan: '',
    calls: [],
    directiveIds: [],
  };
}

export function effortText(input: ReasoningInput): string {
  const lines = [`request: ${head(clean(input.request), 1200)}`];
  const plan = clean(input.plan);
  if (plan) lines.push(`plan: ${tail(plan, 300)}`);
  for (const call of [...input.calls].reverse()) {
    const args = head(clean(call.args), 160);
    lines.push(args ? `call: ${clean(call.name)} ${args}` : `call: ${clean(call.name)}`);
    const output = clean(call.result);
    if (output) lines.push(`result: ${result(output)}`);
  }
  const previousRequest = clean(input.prevRequest);
  if (previousRequest) lines.push(`previous request: ${head(previousRequest, 300)}`);
  const previous = clean(input.prev);
  if (previous) lines.push(`previous reply: ${tail(previous, 300)}`);
  return lines.join('\n');
}
