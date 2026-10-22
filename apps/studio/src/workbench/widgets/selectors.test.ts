import { describe, expect, it } from 'vitest';
import {
  actionRequired,
  activityLine,
  agentActivity,
  changesPresentation,
  fileChangeSignals,
  planBodyStatus,
  planItemTransitions,
  presentContext,
  selectPresentedPlan,
  toolRows,
  visibleWidgets,
  widgetReadState,
  workPlanOpen,
  workPlanPreferenceKey,
} from './selectors.ts';

const plan = (
  revision: number,
  executionId: string,
  scope: 'execution' | 'team' = 'execution',
) => ({
  scope,
  executionId,
  attemptNo: 1,
  revision,
  criteriaVersionId: 'crit_1',
  bodyRef: `art_${revision}_${executionId}`,
  bodyHash: 'b'.repeat(64),
});

const body = (revision: number, statuses: Array<'pending' | 'in_progress' | 'completed'>) => ({
  revision,
  executionId: 'exec_w',
  attemptNo: 1,
  criteriaVersionId: 'crit_1',
  scope: 'execution' as const,
  items: statuses.map((status, index) => ({
    id: `item_${index + 1}`,
    title: `Step ${index + 1}`,
    status,
  })),
});

describe('chat widget selectors', () => {
  it('[TC-ABS-003-H] refreshes file changes after hashline and shell writes, including partial failures', () => {
    const calls = [
      { name: 'edit_hashline', phase: 'finished' },
      { name: 'run_command', phase: 'failed' },
      { name: 'read_hashline', phase: 'finished' },
      { name: 'edit_hashline', phase: 'allowed' },
    ];
    expect(fileChangeSignals(calls, 'running', true)).toEqual({ revision: 2, poll: false });
  });
  it('[TC-ABS-003-N] keeps service changes live after launch, but never polls an archived or paused run', () => {
    const calls = [{ name: 'run_command', phase: 'finished' }];
    expect(fileChangeSignals(calls, 'running', true)).toEqual({ revision: 1, poll: true });
    expect(fileChangeSignals(calls, 'running', false).poll).toBe(false);
    expect(fileChangeSignals(calls, 'paused', true).poll).toBe(false);
    expect(fileChangeSignals(calls, 'succeeded', true).poll).toBe(false);
    expect(
      fileChangeSignals([{ name: 'run_command', phase: 'allowed' }], 'running', true).poll,
    ).toBe(false);
  });
  it('[TC-WIDGET-001-N] PLAN-04 shows live-open errors only for their current target', () => {
    const current = {
      presentationRunId: 'run_current',
      projectionRunId: null,
      sharedRunId: 'run_current',
      sharedStreamError: 'Unavailable',
      sharedMissingRunId: null,
      archiveFailed: false,
    };
    expect(widgetReadState(current)).toBe('error');
    expect(widgetReadState({ ...current, sharedRunId: 'run_previous' })).toBe('loading');
    expect(
      widgetReadState({ ...current, sharedStreamError: null, sharedMissingRunId: 'run_current' }),
    ).toBe('error');
    expect(widgetReadState({ ...current, projectionRunId: 'run_current' })).toBe('error');
    expect(widgetReadState({ ...current, sharedStreamError: null })).toBe('loading');
  });
  it('[TC-WIDGET-001-H] PLAN-02 PLAN-05 PLAN-07 counts items and keeps a manual disclosure', () => {
    const ready = planBodyStatus({
      ref: plan(2, 'exec_w'),
      parsed: { ...body(2, ['completed', 'in_progress', 'pending']), executionId: 'exec_w' },
      textPresent: true,
      failed: false,
      hashMatches: true,
      currentCriteriaVersionId: 'crit_1',
    });
    expect(ready.state).toBe('ready');
    if (ready.state !== 'ready') return;
    expect(ready.completed).toBe(1);
    expect(ready.total).toBe(3);
    expect(ready.runFinished).toBe(false);
    expect(workPlanOpen('auto', 'running')).toBe(true);
    expect(workPlanOpen('auto', 'succeeded')).toBe(false);
    expect(workPlanOpen('open', 'succeeded')).toBe(true);
    expect(workPlanOpen('closed', 'running')).toBe(false);
    expect(
      workPlanPreferenceKey({
        sessionId: 'ses_1',
        runId: 'run_1',
        scope: 'execution',
        owner: 'exec_w',
        attempt: 1,
      }),
    ).not.toContain(':2');
  });

  it('[TC-WIDGET-001-N] PLAN-03 PLAN-04 PLAN-06 PLAN-11 ignore stale bodies and keep unfinished items', () => {
    const current = planBodyStatus({
      ref: plan(3, 'exec_w'),
      parsed: { ...body(2, ['completed']), executionId: 'exec_w' },
      textPresent: true,
      failed: false,
      hashMatches: false,
      currentCriteriaVersionId: 'crit_1',
    });
    expect(current.state).toBe('mismatch');

    const otherRun = planBodyStatus({
      ref: plan(1, 'exec_new'),
      parsed: { ...body(1, ['completed']), executionId: 'exec_old' },
      textPresent: true,
      failed: false,
      hashMatches: true,
      currentCriteriaVersionId: 'crit_1',
    });
    expect(otherRun.state).toBe('mismatch');

    const partial = planBodyStatus({
      ref: plan(1, 'exec_w'),
      parsed: { ...body(1, ['completed', 'pending']), executionId: 'exec_w' },
      textPresent: true,
      failed: false,
      hashMatches: true,
      currentCriteriaVersionId: 'crit_1',
      runStatus: 'succeeded',
    });
    expect(partial.state).toBe('ready');
    if (partial.state === 'ready') {
      expect(partial.completed).toBe(1);
      expect(partial.total).toBe(2);
      expect(partial.runFinished).toBe(true);
      expect(partial.planFinished).toBe(false);
    }

    expect(
      planBodyStatus({
        ref: plan(1, 'exec_w'),
        parsed: null,
        textPresent: false,
        failed: false,
        hashMatches: null,
        currentCriteriaVersionId: 'crit_1',
      }).state,
    ).toBe('loading');
    expect(
      planBodyStatus({
        ref: plan(1, 'exec_w'),
        parsed: null,
        textPresent: true,
        failed: true,
        hashMatches: null,
        currentCriteriaVersionId: 'crit_1',
      }).state,
    ).toBe('error');
    const stale = planBodyStatus({
      ref: { ...plan(1, 'exec_w'), criteriaVersionId: 'crit_old' },
      parsed: {
        ...body(1, ['pending']),
        executionId: 'exec_w',
        criteriaVersionId: 'crit_old',
      },
      textPresent: true,
      failed: false,
      hashMatches: true,
      currentCriteriaVersionId: 'crit_new',
    });
    expect(stale.state).toBe('stale-criteria');
  });

  it('[TC-WIDGET-001-N] PLAN-09 PLAN-10 follows the live execution plan, not a finished team plan', () => {
    const plans = [plan(4, 'exec_planner', 'team'), plan(2, 'exec_worker')];
    const executions = [
      {
        executionId: 'exec_planner',
        roleId: 'planner',
        roleName: 'Planner',
        status: 'succeeded',
        ended: true,
      },
      {
        executionId: 'exec_worker',
        roleId: 'writer',
        roleName: 'Writer',
        status: 'active',
        ended: false,
      },
    ];
    const auto = selectPresentedPlan({ plans, executions, manualKey: null });
    expect(auto.selected?.executionId).toBe('exec_worker');
    expect(auto.selected?.scope).toBe('execution');
    expect(auto.choices.find((choice) => choice.key === 'team')?.lastTeam).toBe(true);
    expect(auto.choices.find((choice) => choice.key === 'team')?.live).toBe(false);

    const manual = selectPresentedPlan({ plans, executions, manualKey: 'team' });
    expect(manual.selected?.scope).toBe('team');
    expect(manual.auto).toBe(false);

    const laterEvent = selectPresentedPlan({
      plans: [plan(9, 'exec_other'), plan(2, 'exec_worker')],
      executions: [
        {
          executionId: 'exec_worker',
          roleId: 'writer',
          roleName: 'Writer',
          status: 'active',
          ended: false,
        },
        {
          executionId: 'exec_other',
          roleId: 'reviewer',
          roleName: 'Reviewer',
          status: 'active',
          ended: false,
        },
      ],
      manualKey: null,
    });
    expect(laterEvent.selected?.executionId).toBe('exec_worker');
  });

  it('[TC-WIDGET-001-N] PLAN-09 does not present a finished planner as the worker live plan', () => {
    const executions = [
      {
        executionId: 'exec_planner',
        roleId: 'planner',
        roleName: 'Planner',
        status: 'succeeded',
        ended: true,
      },
      {
        executionId: 'exec_worker',
        roleId: 'writer',
        roleName: 'Writer',
        status: 'active',
        ended: false,
      },
    ];
    const plans = [plan(1, 'exec_planner'), plan(2, 'exec_planner', 'team')];
    const selected = selectPresentedPlan({ plans, executions, manualKey: null });
    expect(selected.selected).toBeNull();
    expect(selected.choices).toHaveLength(2);
    expect(
      selectPresentedPlan({ plans, executions, manualKey: 'exec_planner' }).selected?.executionId,
    ).toBe('exec_planner');
  });

  it('[TC-WIDGET-001-N] PLAN-10 retains a missing manual target instead of silently enabling follow', () => {
    const selected = selectPresentedPlan({
      plans: [plan(1, 'exec_worker')],
      executions: [
        {
          executionId: 'exec_worker',
          roleId: 'writer',
          roleName: 'Writer',
          status: 'active',
          ended: false,
        },
      ],
      manualKey: 'exec_previous',
    });
    expect(selected.auto).toBe(false);
    expect(selected.selectedKey).toBe('exec_previous');
    expect(selected.selected).toBeNull();
  });

  it('[TC-WIDGET-001-H] PLAN-10 prefers a working child over its waiting parent without event-order hopping', () => {
    const selected = selectPresentedPlan({
      plans: [plan(1, 'exec_parent'), plan(2, 'exec_worker')],
      executions: [
        {
          executionId: 'exec_parent',
          roleId: 'planner',
          roleName: 'Planner',
          status: 'waiting_child',
          ended: false,
        },
        {
          executionId: 'exec_worker',
          roleId: 'writer',
          roleName: 'Writer',
          status: 'active',
          ended: false,
        },
      ],
      manualKey: null,
    });
    expect(selected.selected?.executionId).toBe('exec_worker');
  });

  it('[TC-WIDGET-002-N] CTX-06 never substitutes another execution for an unmeasured selected role', () => {
    const context = presentContext({
      calls: [
        {
          modelCallId: 'call_writer',
          executionId: 'exec_writer',
          recordedAt: '2026-10-19T00:00:00.000Z',
          coverage: 'request',
          completeness: 'complete',
          messageTokens: 100,
          usedTokens: 120,
          parts: [],
          windowTokens: 1000,
          providerInput: null,
          providerCacheRead: null,
          providerOutput: null,
        },
      ],
      compactions: [],
      selectedExecutionId: 'exec_reviewer',
    });
    expect(context.kind).toBe('empty');
    expect(context.tokens).toBeNull();
    expect(context.percent).toBeNull();
    expect(context.executionId).toBe('exec_reviewer');
  });

  it('[TC-WIDGET-002-H] CTX-01 CTX-05 CTX-06 CTX-07 keep windows and partial measurements apart', () => {
    const legacy = presentContext({
      calls: [
        {
          modelCallId: 'call_1',
          executionId: 'exec_1',
          recordedAt: '2026-10-19T00:00:00.000Z',
          coverage: 'legacy-messages',
          completeness: 'legacy',
          messageTokens: 1200,
          usedTokens: null,
          parts: [],
          windowTokens: 200_000,
          providerInput: 50,
          providerCacheRead: 20,
          providerOutput: 10,
        },
      ],
      compactions: [],
      selectedExecutionId: 'exec_1',
      composerWindow: 1_000_000,
    });
    expect(legacy.percent).toBeNull();
    expect(legacy.freeTokens).toBeNull();
    expect(legacy.kind).toBe('messages');
    expect(legacy.tokens).toBe(1200);
    expect(legacy.providerInput).toBe(50);

    const waiting = presentContext({
      calls: [
        {
          modelCallId: 'call_1',
          executionId: 'exec_1',
          recordedAt: '2026-10-19T00:00:00.000Z',
          coverage: 'request',
          completeness: 'complete',
          messageTokens: 10,
          usedTokens: 100,
          parts: [
            { category: 'messages', tokens: 40 },
            { category: 'system_prompt', tokens: 60 },
          ],
          windowTokens: 1000,
          providerInput: 80,
          providerCacheRead: 15,
          providerOutput: 5,
        },
      ],
      compactions: [
        {
          executionId: 'exec_1',
          phase: 'completed',
          recordedAt: '2026-10-19T00:01:00.000Z',
        },
      ],
      selectedExecutionId: 'exec_1',
      composerWindow: 50,
    });
    expect(waiting.awaitingRefresh).toBe(true);
    expect(waiting.percent).toBe(10);
    expect(waiting.tokens).toBe(100);
    expect(waiting.windowTokens).toBe(1000);

    const partial = presentContext({
      calls: [
        {
          modelCallId: 'call_1',
          executionId: 'exec_1',
          recordedAt: '2026-10-19T00:00:00.000Z',
          coverage: 'request',
          completeness: 'partial',
          messageTokens: 4,
          usedTokens: 4,
          parts: [{ category: 'messages', tokens: 4, omission: 'unmeasured_image' }],
          windowTokens: 1000,
          providerInput: null,
          providerCacheRead: null,
          providerOutput: null,
        },
      ],
      compactions: [],
      selectedExecutionId: 'exec_1',
    });
    expect(partial.percent).toBeNull();
    expect(partial.freeTokens).toBeNull();

    const ultra = presentContext({
      calls: [
        {
          modelCallId: 'call_a',
          executionId: 'exec_a',
          recordedAt: '2026-10-19T00:00:00.000Z',
          coverage: 'request',
          completeness: 'complete',
          messageTokens: 10,
          usedTokens: 100,
          parts: [{ category: 'messages', tokens: 100 }],
          windowTokens: 1000,
          providerInput: null,
          providerCacheRead: null,
          providerOutput: null,
        },
        {
          modelCallId: 'call_b',
          executionId: 'exec_b',
          recordedAt: '2026-10-19T00:00:01.000Z',
          coverage: 'request',
          completeness: 'unmeasured',
          messageTokens: null,
          usedTokens: null,
          parts: [],
          windowTokens: 8000,
          providerInput: null,
          providerCacheRead: null,
          providerOutput: null,
        },
      ],
      compactions: [],
      selectedExecutionId: null,
    });
    expect(ultra.kind).toBe('highest');
    expect(ultra.percent).toBe(10);
    expect(ultra.windowTokens).toBe(1000);
    expect(ultra.unmeasuredExecutions).toBe(1);
  });

  it('[TC-WIDGET-001-H] ACTION-01 TOOL-02 keeps decisions and unclear tools visible', () => {
    expect(
      actionRequired({
        pendingApprovals: 1,
        pendingQuestions: 0,
        failedEffects: 0,
        unclearEffects: 0,
      }).visible,
    ).toBe(true);
    expect(
      actionRequired({
        pendingApprovals: 0,
        pendingQuestions: 0,
        failedEffects: 0,
        unclearEffects: 1,
      }).summary,
    ).toBe('unclear');
    const rows = toolRows([
      { toolCallId: 'call_1', name: 'read', phase: 'finished', effect: 'succeeded' },
      { toolCallId: 'call_1', name: 'read', phase: 'finished', effect: 'unknown' },
      { toolCallId: 'call_2', name: 'read', phase: 'finished', effect: 'cancelled' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'call_1', tone: 'unknown' });
    expect(rows[1]).toMatchObject({ id: 'call_2', tone: 'cancelled' });
  });

  it('[TC-WIDGET-001-N] ACTION-01 reports failed or interrupted runs even without a tool effect', () => {
    for (const runStatus of ['failed', 'interrupted']) {
      expect(
        actionRequired({
          pendingApprovals: 0,
          pendingQuestions: 0,
          failedEffects: 0,
          unclearEffects: 0,
          runStatus,
        }),
      ).toMatchObject({ visible: true, summary: 'failure', count: 1, needsUser: false });
    }
    expect(
      actionRequired({
        pendingApprovals: 0,
        pendingQuestions: 0,
        failedEffects: 1,
        unclearEffects: 1,
      }),
    ).toMatchObject({ summary: 'mixed', needsUser: false, hasFailure: true });
  });

  it('[TC-WIDGET-001-H] distinguishes active, queued, paused and failed agent states', () => {
    const executions = [
      'active',
      'queued',
      'paused',
      'waiting_children',
      'failed',
      'succeeded',
    ].map((status, index) => ({
      executionId: `exec_${index}`,
      roleId: `role_${index}`,
      roleName: `Role ${index}`,
      status,
      ended: status === 'failed' || status === 'succeeded',
    }));
    expect(agentActivity(executions)).toEqual({ total: 6, working: 1, waiting: 3, failed: 1 });
    expect(agentActivity([executions[4]!])).toEqual({
      total: 1,
      working: 0,
      waiting: 0,
      failed: 1,
    });
  });

  it('[TC-WIDGET-001-N] SURFACE-02 hides low-priority chips without dropping them', () => {
    const chips = visibleWidgets({
      hasContext: true,
      agents: { total: 3, working: 2, waiting: 1, failed: 0, delegated: true },
      changes: changesPresentation({
        baselineApplied: true,
        provisional: true,
        state: 'ready',
        files: 4,
        lines: 12,
        uncounted: 0,
      }),
      environment: { simulated: true, restricted: false },
    });
    expect(chips).toEqual(['context', 'environment', 'agents', 'changes']);
    expect(
      visibleWidgets({
        hasContext: false,
        agents: { total: 1, working: 1, waiting: 0, failed: 0, delegated: false },
        changes: null,
        environment: null,
        toolCount: 9,
        resultCount: 3,
      }),
    ).toEqual([]);
    expect(
      visibleWidgets({
        hasContext: true,
        agents: { total: 1, working: 0, waiting: 0, failed: 0, delegated: false },
        changes: null,
        environment: null,
      }),
    ).toEqual(['context']);
    expect(
      changesPresentation({
        baselineApplied: false,
        provisional: false,
        state: 'unavailable',
        files: 0,
        lines: 0,
        uncounted: 0,
      }).kind,
    ).not.toBe('count');
  });

  it('[TC-WIDGET-001-H] activity avoids repeating the open plan title and freezes elapsed time', () => {
    const open = activityLine({
      runStatus: 'running',
      startedAt: '2026-10-19T00:00:00.000Z',
      endedAt: null,
      now: '2026-10-19T00:02:00.000Z',
      planTitle: 'Edit the layout',
      planVisible: true,
      toolName: null,
      failed: false,
      needsUser: false,
    });
    expect(open.text).not.toContain('Edit the layout');
    expect(open.elapsedMs).toBe(120_000);
    const done = activityLine({
      runStatus: 'succeeded',
      startedAt: '2026-10-19T00:00:00.000Z',
      endedAt: '2026-10-19T00:03:00.000Z',
      now: '2026-10-19T00:09:00.000Z',
      planTitle: null,
      planVisible: false,
      toolName: null,
      failed: false,
      needsUser: false,
    });
    expect(done.elapsedMs).toBe(180_000);
    expect(done.frozen).toBe(true);
    const unfinished = activityLine({
      runStatus: 'succeeded',
      startedAt: '2026-10-19T00:00:00.000Z',
      endedAt: '2026-10-19T00:03:00.000Z',
      now: '2026-10-19T00:09:00.000Z',
      planTitle: 'Old unfinished item',
      planVisible: false,
      toolName: null,
      failed: false,
      needsUser: false,
    });
    expect(unfinished.text).toBe('elapsed');
    for (const runStatus of ['paused', 'pausing', 'cancelling', 'cancelled', 'interrupted']) {
      expect(
        activityLine({
          runStatus,
          startedAt: '2026-10-19T00:00:00.000Z',
          endedAt: null,
          now: '2026-10-19T00:09:00.000Z',
          planTitle: 'Old stage',
          planVisible: false,
          toolName: 'write_file',
          failed: false,
          needsUser: false,
        }).text,
      ).toBe(runStatus);
    }
    const vague = activityLine({
      runStatus: 'running',
      startedAt: null,
      endedAt: null,
      now: '2026-10-19T00:00:00.000Z',
      planTitle: null,
      planVisible: false,
      toolName: null,
      failed: false,
      needsUser: false,
    });
    expect(vague.text).toBe('working');
    expect(vague.elapsedMs).toBeNull();
  });
});

describe('planItemTransitions', () => {
  const items = (...statuses: ('pending' | 'in_progress' | 'completed')[]) =>
    statuses.map((status, index) => ({
      id: `step_${index + 1}`,
      title: `Step ${index + 1}`,
      status,
    }));
  const seen = (key: string, ...statuses: ('pending' | 'in_progress' | 'completed')[]) => ({
    key,
    statuses: Object.fromEntries(items(...statuses).map((item) => [item.id, item.status])),
  });

  it('marks only rows whose status changed while the same plan was in view', () => {
    expect(
      planItemTransitions({
        previous: seen('run_1:exec_a:1', 'completed', 'in_progress', 'pending', 'pending'),
        key: 'run_1:exec_a:1',
        items: items('completed', 'completed', 'in_progress', 'pending'),
        watching: true,
      }),
    ).toEqual({ completed: ['step_2'], started: ['step_3'] });
    // A skipped step, a reopened step and an item new to this revision.
    expect(
      planItemTransitions({
        previous: seen('k', 'completed', 'pending'),
        key: 'k',
        items: [
          ...items('in_progress', 'completed'),
          { id: 'step_9', title: 'New', status: 'completed' },
        ],
        watching: true,
      }),
    ).toEqual({ completed: ['step_2'], started: ['step_1'] });
  });

  it('does not replay history on first view, after a target switch, or while collapsed', () => {
    const next = items('completed', 'in_progress');
    expect(planItemTransitions({ previous: null, key: 'k', items: next, watching: true })).toEqual({
      completed: [],
      started: [],
    });
    expect(
      planItemTransitions({
        previous: seen('run_1:exec_a:1', 'pending', 'pending'),
        key: 'run_2:exec_a:1',
        items: next,
        watching: true,
      }),
    ).toEqual({ completed: [], started: [] });
    expect(
      planItemTransitions({
        previous: seen('k', 'pending', 'pending'),
        key: 'k',
        items: next,
        watching: false,
      }),
    ).toEqual({ completed: [], started: [] });
    expect(
      planItemTransitions({
        previous: seen('k', 'completed', 'in_progress'),
        key: 'k',
        items: next,
        watching: true,
      }),
    ).toEqual({ completed: [], started: [] });
  });
});
