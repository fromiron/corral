import { canonicalJson, type ModelProfileSnapshot, type ResolvedInput } from '@corral/contracts';
import { contextBudgetLimitsFor } from '@corral/pi-runtime-port/budget';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** Half the available input is reserved for instructions, tools, state and follow-up reads. */
export function projectJudgeInputs(inputs: ResolvedInput[], model: ModelProfileSnapshot) {
  const { hardLimit } = contextBudgetLimitsFor({
    contextWindow: model.contextPolicy?.contextWindow ?? model.contextWindow ?? undefined,
    maxTokens: model.maxOutputTokens,
  });
  const budgetBytes = Math.max(1, hardLimit - 512);
  const packets = inputs.map((input) =>
    /^(candidate_[A-E]|previous|proposed)$/.test(input.name)
      ? {
          input,
          value: JSON.parse(input.text) as {
            report: string;
            diff: string;
            checks: { output: string }[];
          },
        }
      : null,
  );
  const excerpt = (text: string, scale: number) => {
    const points = Array.from(text),
      length = Math.floor(points.length * scale);
    return length >= points.length
      ? text
      : `${points.slice(0, Math.ceil(length * 0.8)).join('')}\n[Excerpt; read the original source range before citing omitted evidence.]\n${points.slice(points.length - Math.floor(length * 0.2)).join('')}`;
  };
  let scale = 1;
  for (;;) {
    const projected = inputs.map((input, index) => {
      const packet = packets[index];
      if (!packet || scale === 1) return input;
      const value = packet.value;
      return {
        ...input,
        text: canonicalJson({
          ...value,
          report: excerpt(value.report, scale),
          diff: excerpt(value.diff, scale),
          checks: value.checks.map((check) => ({ ...check, output: excerpt(check.output, scale) })),
          source: {
            artifactVersionId: input.sourceRef,
            tool: 'read_artifact',
            offset: 0,
            limit: 8192,
          },
          excerpt: true,
        }),
      };
    });
    const bytes = utf8ToBytes(canonicalJson(projected)).length;
    if (bytes <= budgetBytes) return projected;
    if (scale === 0)
      throw new Error(
        'judge context cannot retain required task, criteria and evidence references',
      );
    scale = scale < 0.00001 ? 0 : scale * Math.min(0.75, budgetBytes / bytes);
  }
}
