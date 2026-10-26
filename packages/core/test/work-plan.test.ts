import type { AgentHost, AgentStartInput } from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it } from 'vitest';
import { Coordinator, InMemoryRunStore } from '../src/index.ts';

it.each([false, true])(
  'plans enforce ownership, revisions, one active step and required evidence without completing the task (team=%s)',
  async (team) => {
    const started = new Gate(),
      done = new Gate(),
      store = new InMemoryRunStore();
    let host!: AgentHost, input!: AgentStartInput;
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      store,
      agents: {
        start: async (i, h) => {
          input = i;
          host = h;
          started.open();
          return {
            cancel: async () => done.open(),
            waitForSettlement: async () => {
              await done.wait();
              return { outcome: 'cancelled' as const };
            },
          };
        },
      },
    });
    const definition = linearCorral(['writer']);
    definition.roles[0]!.allowedCollaborationTools.push('update_plan');
    if (team) definition.planOwnerRoleId = definition.roles[0]!.id;
    const start = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'plan_run',
      definition,
      mode: 'mock',
    });
    expect(start.runId).not.toBeNull();
    await started.wait();
    const update = (args: Record<string, unknown>) =>
      host.invokeTool({
        name: 'update_plan',
        args: {
          scope: team ? 'team' : 'execution',
          criteriaVersionId: input.criteriaVersionId,
          ...args,
        },
      });
    const steps = [
      { id: 'build', title: 'Private implementation step', status: 'in_progress' },
      { id: 'verify', title: 'Verify', status: 'pending', requiresVerification: true },
    ];
    try {
      const initial = await update({ expectedRevision: 0, items: steps });
      expect(initial, JSON.stringify(initial)).toMatchObject({ ok: true, result: { revision: 1 } });
      const protectedContext = host.protectedContext!();
      expect(protectedContext.text).toContain('Private implementation step');
      expect(protectedContext.text).toContain(input.criteriaVersionId);
      expect(protectedContext.text).toContain(input.executionId);
      expect(JSON.stringify(store.readEvents(input.runId, 0))).not.toContain(
        'Private implementation',
      );
      expect(await update({ expectedRevision: 0, items: steps })).toMatchObject({ ok: false });
      if (!team)
        expect(await update({ expectedRevision: 1, scope: 'team', items: steps })).toMatchObject({
          ok: false,
        });
      expect(
        await update({
          expectedRevision: 1,
          items: steps.map((s) => ({ ...s, status: 'in_progress' })),
        }),
      ).toMatchObject({ ok: false });
      expect(await update({ expectedRevision: 1, items: steps.slice(0, 1) })).toMatchObject({
        ok: false,
      });
      expect(
        await update({
          expectedRevision: 1,
          items: steps.map((s) => ({ ...s, status: 'completed', evidenceRefs: ['artv_fake'] })),
        }),
      ).toMatchObject({ ok: false });
      const results = await Promise.all([
        update({ expectedRevision: 1, items: steps }),
        update({ expectedRevision: 1, items: steps }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(coordinator.getSnapshot(input.runId).projection.tasks[input.taskId]?.status).not.toBe(
        'completed',
      );
      expect(coordinator.getSnapshot(input.runId).projection.status).toBe('running');
    } finally {
      done.open();
    }
  },
);
