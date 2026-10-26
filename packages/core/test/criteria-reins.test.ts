import { CorralDefinition } from '@corral/contracts';
import { FakeClock, Gate, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { Coordinator, InProcessTransport, waitForProjection } from '../src/index.ts';

it('a criteria patch keeps current round frozen and requires the next round before accepting old pass', async () => {
  const gate = new Gate();
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      review: () => 'pass',
      beforeReply: async (_turn, input) => {
        if (input.role.outputContract === 'review' && input.round === 1) await gate.wait();
      },
    }),
  });
  const transport = new InProcessTransport(coordinator);
  const { runId } = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition: CorralDefinition.parse(researchTeam),
    mode: 'mock',
  });
  if (!runId) throw new Error('the criteria fixture run did not start');
  const initial = await waitForProjection(transport, runId, (p) =>
    Object.values(p.executions).some((e) => e.nodeId === 'review' && e.modelCallIds.length === 1),
  );
  const oldCriteria = initial.currentCriteriaVersionId;
  if (!oldCriteria) throw new Error('the run has no initial criteria version');
  const patch = coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'criteria',
    runId,
    type: 'patch',
    expectedControlRevision: 0,
    payload: {
      kind: 'criteria',
      baseCriteriaVersionId: oldCriteria,
      criteria: ['Every factual claim cites a primary source.'],
    },
  });
  expect(patch.status).toBe('applied');
  const changed = coordinator.getSnapshot(runId).projection.currentCriteriaVersionId;
  if (!changed) throw new Error('the criteria patch has no version');
  expect(changed).not.toBe(oldCriteria);
  gate.open();
  const pending = await waitForProjection(transport, runId, (p) => p.status === 'awaiting_user');
  const approval = Object.values(pending.approvals).find((a) => a.status === 'pending');
  if (!approval) throw new Error('the changed criteria require a pending approval');
  const subjectVersionId = approval.subjectVersionIds[0];
  if (!subjectVersionId) throw new Error('the pending approval has no subject');
  expect(approval.kind).toBe('user_action');
  expect(approval.criteriaVersionId).toBe(changed);
  expect(Object.values(pending.iterations)).toHaveLength(1);
  expect(Object.values(pending.iterations)[0]?.criteriaVersionId).toBe(oldCriteria);
  expect(Object.values(pending.reviews)[0]?.stale).toBe(true);
  coordinator.submit({
    schemaVersion: '0.1',
    runId,
    commandId: 'next-round',
    type: 'resolve_approval',
    expectedControlRevision: 1,
    payload: {
      approvalId: approval.approvalId,
      decision: 'approve',
      subjectVersionId,
    },
  });
  const final = await waitForProjection(
    transport,
    runId,
    (p) =>
      Object.keys(p.iterations).length === 2 &&
      p.status === 'awaiting_user' &&
      Object.values(p.approvals).some(
        (a) => a.approvalId !== approval.approvalId && a.status === 'pending',
      ),
  );
  expect(Object.values(final.iterations).map((i) => i.criteriaVersionId)).toEqual([
    oldCriteria,
    changed,
  ]);
  expect(
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'too-late',
      runId,
      type: 'patch',
      expectedControlRevision: 1,
      payload: { kind: 'criteria', baseCriteriaVersionId: changed, criteria: ['Late change'] },
    }).error?.code,
  ).toBe('CRITERIA_CHANGE_REQUIRES_NEW_RUN');
});
