import { type OutputNode, TeamComposition } from '@corral/contracts';
import {
  compileDefinition,
  draftFromComposition,
  planRun,
  ROLE_PRESET_IDS,
  roleFromPreset,
  teamCatalog,
} from '@corral/core';
import { describe, expect, it } from 'vitest';
import { draftFromDefinition } from '../src/editor/model.ts';
import { setRequiredOutputReview } from '../src/team-editor/commands.ts';

// A composed team that asks for a required review gets it from the editor's own command once the
// person confirms a received result (docs/specs/features/team-assistant.md, "필수 통과"). Every
// result of a composed team's Output must take it, whatever its last step.

const resolved = teamCatalog(
  ROLE_PRESET_IDS.map((id) => {
    const { id: _id, ...role } = roleFromPreset(id, id, `${id} agent`);
    return { role, origin: { kind: 'preset' as const, presetId: id }, builtin: true };
  }),
  [],
);
const agent = (name: string) =>
  resolved.catalog.agents.find((a) => a.name === `${name} agent`)?.id as string;
const seat = (id: string, name: string) => ({
  id,
  agent: agent(name),
  name: id,
  duty: `Do ${id}.`,
});
const labels = {
  loop: 'Review loop',
  decision: 'Review decision',
  join: 'Gather',
  output: 'Output',
};
const gate = { loop: '제출 전 검토', reviewer: '제출 전 검토자', decision: '제출 전 판정' };

const composed = (seats: ReturnType<typeof seat>[], flow: unknown) =>
  draftFromDefinition(
    draftFromComposition(
      TeamComposition.parse({
        name: 'Composed',
        brief: 'Ship it.',
        criteria: ['Do what the brief asks.'],
        seats,
        flow,
        outrider: 'required_review',
      }),
      'composed_1',
      resolved,
      labels,
    ),
  );

describe('a required review on a composed team', () => {
  it.each([
    [
      'a loop',
      [seat('plan', 'architect'), seat('write', 'writer'), seat('check', 'reviewer')],
      [{ seat: 'plan' }, { loop: { work: ['write'], judge: 'check' } }],
    ],
    [
      'a group side by side',
      [seat('plan', 'architect'), seat('a', 'researcher'), seat('b', 'explainer')],
      [{ seat: 'plan' }, { parallel: ['a', 'b'] }],
    ],
  ] as const)('whose last step is %s takes it on every received result', (_name, seats, flow) => {
    const draft = composed([...seats], flow);
    const output = draft.definition.nodes.find((n): n is OutputNode => n.type === 'output');
    if (!output) throw new Error('no Output');
    expect(output.inputBindings.length).toBeGreaterThan(0);
    for (const [index, binding] of output.inputBindings.entries()) {
      const result = setRequiredOutputReview(
        draft,
        output.id,
        binding.name,
        binding.sourceNodeId as string,
        gate,
        index,
      );
      if (!result.ok) throw new Error(`result ${index}: ${result.reason}`);
      const reviewed = result.draft.definition.nodes.find(
        (n): n is OutputNode => n.type === 'output',
      );
      expect(reviewed?.requiredReviews).toHaveLength(1);
      expect(reviewed?.requiredReviews?.[0]).toMatchObject({ sourceNodeId: binding.sourceNodeId });
      const compiled = compileDefinition(result.draft.definition, {
        knownModelProfiles: ['model-a', 'model-b'],
      });
      expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(planRun(result.draft.definition).ok).toBe(true);
    }
  });
});
