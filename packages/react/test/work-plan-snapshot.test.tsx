import type { WorkPlan } from '@corral/contracts';
import { canonicalJson } from '@corral/core';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { WorkPlanPanel } from '../src/components/WorkPlanPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { useWorkPlanSnapshot, type WorkPlanSnapshotInput } from '../src/run/work-plan-snapshot.ts';
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

const body: WorkPlan = {
  scope: 'execution',
  executionId: 'execution_1',
  attemptNo: 1,
  revision: 1,
  criteriaVersionId: 'criteria_1',
  items: [
    { id: 'inspect', title: 'Inspect the source', status: 'completed' },
    { id: 'verify', title: 'Verify the change', status: 'in_progress' },
  ],
};

async function reference(plan = body) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(plan)));
  return {
    scope: plan.scope,
    executionId: plan.executionId,
    attemptNo: plan.attemptNo,
    revision: plan.revision,
    criteriaVersionId: plan.criteriaVersionId,
    bodyRef: `plan_${plan.executionId}_${plan.revision}`,
    bodyHash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('shared work plan snapshots (CR-041 PLAN-03/04/05/06/11, PERF-01)', () => {
  it('the historical panel never displays completion from a body with the wrong hash', async () => {
    const ref = await reference();
    const session = sessionStore({
      runId: 'run_1',
      projection: projectionWith({
        runId: 'run_1',
        currentCriteriaVersionId: body.criteriaVersionId,
        workPlans: { execution_1: ref },
      }),
      artifactTexts: {
        [ref.bodyRef]: JSON.stringify({
          ...body,
          items: [{ id: 'forged', title: 'Unverified completion', status: 'completed' }],
        }),
      },
    });
    render(
      <IntlProvider locale="en" messages={messages}>
        <WorkPlanPanel session={session} />
      </IntlProvider>,
    );
    expect(screen.queryByText('Unverified completion')).not.toBeInTheDocument();
    expect(await screen.findByText(messages.WorkPlan.unavailable)).toBeVisible();
  });

  it('deduplicates composer and detail reads without merging runs or transports', async () => {
    const ref = await reference();
    const loading = deferred<string | null>();
    const load = vi.fn(() => loading.promise);
    const input: WorkPlanSnapshotInput = {
      runId: 'run_1',
      ref,
      currentCriteriaVersionId: body.criteriaVersionId,
      load,
      cacheScope: {},
    };
    const first = renderHook(() => useWorkPlanSnapshot(input));
    const second = renderHook(() => useWorkPlanSnapshot(input));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => loading.resolve(JSON.stringify(body)));
    await waitFor(() => expect(first.result.current.status.state).toBe('ready'));
    expect(second.result.current.status).toEqual(first.result.current.status);
    const otherRun = renderHook(() => useWorkPlanSnapshot({ ...input, runId: 'run_2' }));
    const otherScope = {};
    const otherTransport = renderHook(() =>
      useWorkPlanSnapshot({ ...input, cacheScope: otherScope }),
    );
    await waitFor(() => expect(otherRun.result.current.status.state).toBe('ready'));
    await waitFor(() => expect(otherTransport.result.current.status.state).toBe('ready'));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a late %s after moving to a new run and revision',
    async (settle) => {
      const old = deferred<string | null>();
      const nextBody = { ...body, revision: 2 };
      const firstRef = await reference();
      const nextRef = await reference(nextBody);
      const load = vi.fn((ref: string) =>
        ref === firstRef.bodyRef ? old.promise : Promise.resolve(JSON.stringify(nextBody)),
      );
      const input: WorkPlanSnapshotInput = {
        runId: 'run_1',
        ref: firstRef,
        currentCriteriaVersionId: body.criteriaVersionId,
        load,
        cacheScope: {},
      };
      const hook = renderHook((props) => useWorkPlanSnapshot(props), { initialProps: input });
      await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      hook.rerender({ ...input, runId: 'run_2', ref: nextRef });
      expect(hook.result.current.status.state).toBe('loading');
      await waitFor(() => expect(hook.result.current.status.state).toBe('ready'));
      await act(async () => {
        if (settle === 'resolve') old.resolve(JSON.stringify(body));
        else old.reject(new Error('old run unavailable'));
      });
      expect(hook.result.current.status).toMatchObject({
        state: 'ready',
        plan: { revision: 2 },
      });
    },
  );

  it.each([null, 'invalid JSON'])(
    'treats missing or malformed body %s as retryable',
    async (text) => {
      const ref = await reference();
      const scope = {};
      const load = vi
        .fn<WorkPlanSnapshotInput['load']>()
        .mockResolvedValueOnce(text)
        .mockResolvedValueOnce(JSON.stringify(body));
      const hook = renderHook(() =>
        useWorkPlanSnapshot({
          runId: 'run_1',
          ref,
          currentCriteriaVersionId: body.criteriaVersionId,
          cacheScope: scope,
          load,
        }),
      );
      await waitFor(() => expect(hook.result.current.status.state).toBe('error'));
      act(() => hook.result.current.retry());
      await waitFor(() => expect(hook.result.current.status.state).toBe('ready'));
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it('does not reuse verified bytes when scope or expected hash changes', async () => {
    const ref = await reference();
    const input: WorkPlanSnapshotInput = {
      runId: 'run_1',
      ref,
      currentCriteriaVersionId: body.criteriaVersionId,
      cacheScope: {},
      text: JSON.stringify(body),
      load: vi.fn(),
    };
    const hook = renderHook((props) => useWorkPlanSnapshot(props), { initialProps: input });
    await waitFor(() => expect(hook.result.current.status.state).toBe('ready'));
    hook.rerender({ ...input, ref: { ...ref, scope: 'team' } });
    expect(hook.result.current.status.state).toBe('loading');
    await waitFor(() => expect(hook.result.current.status.state).toBe('mismatch'));
    hook.rerender({ ...input, ref: { ...ref, bodyHash: '0'.repeat(64) } });
    await waitFor(() => expect(hook.result.current.status.state).toBe('mismatch'));
    hook.rerender({
      ...input,
      text: JSON.stringify({ ...body, items: [{ ...body.items[0], title: 'Changed bytes' }] }),
    });
    await waitFor(() => expect(hook.result.current.status.state).toBe('mismatch'));
  });

  it('explicit retry reloads an invalid cached body instead of validating the same bytes again', async () => {
    const ref = await reference();
    const scope = {};
    const load = vi.fn(async () => JSON.stringify(body));
    const hook = renderHook(() =>
      useWorkPlanSnapshot({
        runId: 'run_1',
        ref,
        currentCriteriaVersionId: body.criteriaVersionId,
        cacheScope: scope,
        text: 'invalid cached JSON',
        load,
      }),
    );
    await waitFor(() => expect(hook.result.current.status.state).toBe('error'));
    expect(load).not.toHaveBeenCalled();
    act(() => hook.result.current.retry());
    await waitFor(() => expect(hook.result.current.status.state).toBe('ready'));
    expect(load).toHaveBeenCalledExactlyOnceWith(ref.bodyRef, { reload: true });
  });

  it('preserves partial counts on run cancellation and marks historical criteria and attempts', async () => {
    const ref = await reference();
    const input: WorkPlanSnapshotInput = {
      runId: 'run_1',
      ref,
      currentCriteriaVersionId: body.criteriaVersionId,
      currentAttemptNo: 1,
      runStatus: 'running',
      cacheScope: {},
      text: JSON.stringify(body),
      load: vi.fn(),
    };
    const hook = renderHook((props) => useWorkPlanSnapshot(props), { initialProps: input });
    await waitFor(() =>
      expect(hook.result.current.status).toMatchObject({
        state: 'ready',
        completed: 1,
        total: 2,
        planFinished: false,
        runFinished: false,
      }),
    );
    hook.rerender({ ...input, runStatus: 'cancelled' });
    expect(hook.result.current.status).toMatchObject({
      state: 'ready',
      completed: 1,
      total: 2,
      planFinished: false,
      runFinished: true,
    });
    hook.rerender({ ...input, currentCriteriaVersionId: 'criteria_2' });
    expect(hook.result.current.status).toMatchObject({ state: 'stale-criteria', completed: 1 });
    hook.rerender({ ...input, currentAttemptNo: 2 });
    expect(hook.result.current.status).toMatchObject({ state: 'stale-attempt', completed: 1 });
  });

  it('does not equate a completed plan with a running execution finishing', async () => {
    const complete: WorkPlan = {
      ...body,
      items: body.items.map((item) => ({ ...item, status: 'completed' })),
    };
    const ref = await reference(complete);
    const scope = {};
    const hook = renderHook(() =>
      useWorkPlanSnapshot({
        runId: 'run_1',
        ref,
        currentCriteriaVersionId: body.criteriaVersionId,
        cacheScope: scope,
        text: JSON.stringify(complete),
        runStatus: 'running',
        load: vi.fn(),
      }),
    );
    await waitFor(() =>
      expect(hook.result.current.status).toMatchObject({
        state: 'ready',
        completed: 2,
        planFinished: true,
        runFinished: false,
      }),
    );
  });
});
