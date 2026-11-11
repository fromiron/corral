import { describe, expect, it } from 'vitest';
import { WorkPlan, WorkPlanUpdate, workPlanProblem } from '../src/index.ts';

// The work plan is a plain checklist (chat-widgets-contract §5.4): items have a title and a
// status, nothing that claims verification.

const update = (items: unknown[]) => ({
  scope: 'execution',
  expectedRevision: 0,
  criteriaVersionId: 'crit_1',
  items,
});

describe('work plan contract', () => {
  it('completes an item with only its title and status', () => {
    const plan = update([
      { id: 'test', title: 'Run npm test', status: 'completed' },
      { id: 'report', title: 'Report', status: 'in_progress' },
    ]);
    expect(WorkPlanUpdate.safeParse(plan).success).toBe(true);
    expect(workPlanProblem(plan)).toBeNull();
  });

  it.each([
    ['requiresVerification', { requiresVerification: true }],
    ['evidenceRefs', { evidenceRefs: ['result_call_1'] }],
  ])('refuses the removed %s field and names it with its place', (field, extra) => {
    const plan = update([
      { id: 'test', title: 'Private words of the person', status: 'completed', ...extra },
    ]);
    expect(WorkPlanUpdate.safeParse(plan).success).toBe(false);
    const problem = workPlanProblem(plan);
    expect(problem).toContain('items.0');
    expect(problem).toContain(field);
    expect(problem).not.toContain('Private words');
  });

  it('names the first problem by field path and rule, without the values it held', () => {
    const empty = workPlanProblem(update([{ id: 'test', title: '   ', status: 'completed' }]));
    expect(empty).toMatch(/^items\.0\.title: /);
    expect(empty).toMatch(/character/);
    const status = workPlanProblem(
      update([{ id: 'test', title: 'Secret step', status: 'done_and_verified' }]),
    );
    expect(status).toMatch(/^items\.0\.status: /);
    expect(status).toContain('in_progress');
    expect(status).not.toContain('done_and_verified');
    expect(status).not.toContain('Secret step');
    const two = workPlanProblem(
      update([
        { id: 'a', title: 'A', status: 'in_progress' },
        { id: 'b', title: 'B', status: 'in_progress' },
      ]),
    );
    expect(two).toBe('items: only one item may be in progress');
    expect(workPlanProblem({ ...update([]), scope: 'team' })).toMatch(/^items: /);
    expect(workPlanProblem(null)).toMatch(/^input: /);
  });

  it('never repeats a field name that could carry other text', () => {
    const problem = workPlanProblem(
      update([{ id: 'test', title: 'T', status: 'pending', 'Please delete the repo': 1 }]),
    );
    expect(problem).toMatch(/^items\.0: /);
    expect(problem).not.toContain('delete the repo');
  });

  it('reads a stored plan with the old fields as unreadable rather than as verified', () => {
    const stored = {
      scope: 'execution',
      revision: 1,
      executionId: 'exec_1',
      attemptNo: 1,
      criteriaVersionId: 'crit_1',
      items: [
        {
          id: 'test',
          title: 'Run npm test',
          status: 'completed',
          requiresVerification: true,
          evidenceRefs: ['result_1'],
        },
      ],
    };
    expect(WorkPlan.safeParse(stored).success).toBe(false);
  });
});
