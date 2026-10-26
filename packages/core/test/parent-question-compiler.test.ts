import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { compileDefinition } from '../src/compiler/index.ts';

function definition() {
  const draft = JSON.parse(JSON.stringify(researchTeam)) as typeof researchTeam;
  const link = draft.capabilityLinks.find((item) => item.sourceNodeId === 'research');
  if (!link) throw new Error('Missing example delegate link');
  Object.assign(link, { parentQuestions: true });
  const parent = draft.roles.find((role) => role.id === 'researcher');
  const child = draft.roles.find((role) => role.id === 'helper');
  if (!parent || !child) throw new Error('Missing example roles');
  if (!parent.allowedCollaborationTools.includes('reply'))
    parent.allowedCollaborationTools.push('reply');
  if (!child.allowedCollaborationTools.includes('ask')) child.allowedCollaborationTools.push('ask');
  return draft;
}

describe('parent question compilation', () => {
  it('adds an explicit parent route without a reverse callable edge or added depth', () => {
    const compiled = compileDefinition(definition());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.plan.callables.research).toMatchObject({ replyToChildren: true });
    expect(compiled.plan.callables.helper).toMatchObject({
      delegate: [],
      question: [],
      parentQuestion: ['research'],
    });
    expect(compiled.plan.summary.maxStaticDepth).toBe(2);
    expect(compiled.plan.order).not.toContain('helper');
  });

  it('preserves legacy plans when the opt-in is absent', () => {
    const compiled = compileDefinition(researchTeam);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.definition).toEqual(researchTeam);
    expect(compiled.plan.callables).toEqual({
      research: { delegate: ['helper'], question: [] },
      respond: { delegate: ['helper'], question: [] },
      write: { delegate: [], question: ['respond'] },
    });
  });

  it('rejects parent delivery on question links and missing participant tool permission', () => {
    const onQuestion = definition();
    Object.assign(onQuestion.capabilityLinks.find((link) => link.kind === 'question') ?? {}, {
      parentQuestions: true,
    });
    expect(compileDefinition(onQuestion).ok).toBe(false);
    for (const [roleId, tool] of [
      ['researcher', 'reply'],
      ['helper', 'ask'],
    ]) {
      const withoutTool = definition();
      const role = withoutTool.roles.find((item) => item.id === roleId);
      if (!role) throw new Error('Missing test role');
      role.allowedCollaborationTools = role.allowedCollaborationTools.filter(
        (item) => item !== tool,
      );
      const result = compileDefinition(withoutTool);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({ code: 'CAPABILITY_NOT_ALLOWED' }),
        );
    }
  });
});
