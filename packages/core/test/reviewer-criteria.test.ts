import { type AgentStartInput, CorralDefinition } from '@corral/contracts';
import { FakeClock, Gate, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import headlessTeam from '../../../examples/eval/research-team-headless.corral.json' with {
  type: 'json',
};
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  Coordinator,
  compileDefinition,
  InProcessTransport,
  waitForProjection,
} from '../src/index.ts';

async function until(done: () => boolean) {
  for (let i = 0; i < 20_000 && !done(); i++) await Promise.resolve();
  if (!done()) throw new Error('timed out');
}

// Issue #20: a reviewer must receive the criteria text it reviews against, as the same version
// its criteriaVersionId names; a criteria patch reaches the next round only.

describe('reviewers receive the criteria text (#20)', () => {
  it('[TC-ART-003-H] the shipped research teams give their reviewer the current criteria, and a patch reaches the next round only', async () => {
    const gate = new Gate();
    const seen: AgentStartInput[] = [];
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({
        turns: 1,
        review: () => 'pass',
        beforeReply: async (_turn, input) => {
          if (input.role.outputContract !== 'review') return;
          seen.push(JSON.parse(JSON.stringify(input)) as AgentStartInput);
          if (input.round === 1) await gate.wait();
        },
      }),
    });
    const transport = new InProcessTransport(coordinator);
    const definition = CorralDefinition.parse(researchTeam);
    const { runId } = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      definition,
      mode: 'mock',
    });
    if (!runId) throw new Error('no run');
    await until(() => seen.length === 1);
    const first = seen[0];
    const firstCriteria = first?.inputs.find((i) => i.name === 'criteria');
    expect(firstCriteria?.text).toBe(definition.input.criteria.join('\n'));
    expect(first?.criteriaVersionId).toBe(
      coordinator.getSnapshot(runId).projection.currentCriteriaVersionId,
    );
    expect(coordinator.getArtifactText(runId, first?.criteriaVersionId ?? '')).toBe(
      firstCriteria?.text,
    );

    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'criteria',
      runId,
      type: 'patch',
      expectedControlRevision: 0,
      payload: {
        kind: 'criteria',
        baseCriteriaVersionId: first?.criteriaVersionId ?? '',
        criteria: ['Every factual claim cites a primary source.'],
      },
    });
    gate.open();
    const pending = await waitForProjection(transport, runId, (p) => p.status === 'awaiting_user');
    const approval = Object.values(pending.approvals).find((a) => a.status === 'pending');
    coordinator.submit({
      schemaVersion: '0.1',
      runId,
      commandId: 'next-round',
      type: 'resolve_approval',
      expectedControlRevision: 1,
      payload: {
        approvalId: approval?.approvalId ?? '',
        decision: 'approve',
        subjectVersionId: approval?.subjectVersionIds[0] ?? '',
      },
    });
    await until(() => seen.length === 2);
    const second = seen[1];
    expect(second?.inputs.find((i) => i.name === 'criteria')?.text).toBe(
      'Every factual claim cites a primary source.',
    );
    expect(second?.criteriaVersionId).not.toBe(first?.criteriaVersionId);
    expect(coordinator.getArtifactText(runId, second?.criteriaVersionId ?? '')).toBe(
      'Every factual claim cites a primary source.',
    );
    // The first round's request keeps what it was given.
    expect(seen[0]?.inputs.find((i) => i.name === 'criteria')?.text).toBe(firstCriteria?.text);
  });

  it('[TC-ART-003-N] a reviewer without the criteria input is flagged before the run; the shipped teams are not', () => {
    for (const shipped of [researchTeam, headlessTeam]) {
      const compiled = compileDefinition(shipped);
      expect(compiled.ok).toBe(true);
      expect(compiled.diagnostics.filter((d) => d.code === 'REVIEW_WITHOUT_CRITERIA')).toEqual([]);
    }
    const stripped = JSON.parse(JSON.stringify(researchTeam)) as typeof researchTeam;
    for (const node of stripped.nodes) {
      if (node.id === 'review' && node.inputBindings) {
        node.inputBindings = node.inputBindings.filter((b) => b.name !== 'criteria');
      }
    }
    const compiled = compileDefinition(stripped);
    expect(compiled.ok).toBe(true);
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'REVIEW_WITHOUT_CRITERIA',
        severity: 'warning',
        nodeId: 'review',
      }),
    );
  });
});
