// The judgment text for an effort decision: a copy of the request input, never the model's own
// context. The fields follow the judge text the effort model was trained on: the task line, the
// stage, the current request, the earlier turn, the plan, then each tool call in supplied order.
// Nothing is clipped here; the engine keeps the first tokens up to the effort model's limit, so
// the current request survives first. Changing anything here changes the embeddings the
// classifier was trained on, so it needs a new version and new weights.
import type { ReasoningInput } from '@corral/contracts';

export const EFFORT_PREPROCESS_VERSION = 'effort-text-v2';

/** A judgment input that has only the request text, as the observe path sees it. */
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
  return [
    'Task: choose the minimum reasoning effort for the NEXT coding response.',
    `Stage: ${input.kind}`,
    `Current request: ${input.request}`,
    ...(input.prevRequest ? [`Previous user request: ${input.prevRequest}`] : []),
    ...(input.prev ? [`Previous reply: ${input.prev}`] : []),
    ...(input.plan ? [`Current plan: ${input.plan}`] : []),
    ...input.calls.flatMap((call, index) => [
      `Tool ${index + 1}: ${call.name}; status: ${call.status ?? 'completed'}`,
      ...(call.args ? [`Arguments: ${call.args}`] : []),
      `Observed output: ${call.result}`,
    ]),
  ].join('\n');
}
