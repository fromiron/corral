import type { CorralDefinition } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { IntlProvider } from 'use-intl';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RunCanvas } from '../src/components/RunCanvas.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { runCanvasLayout } from '../src/run/layout.ts';
import { useSteerTarget } from '../src/run/steer-target.ts';
import { projectionWith, researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const team = () => researchTeamDraft();

const execution = (
  executionId: string,
  nodeId: string,
  extra: Partial<RunProjection['executions'][string]> = {},
): RunProjection['executions'][string] => ({
  executionId,
  nodeId,
  taskId: `task_${executionId}`,
  attemptNo: 1,
  parentExecutionId: null,
  previousExecutionId: null,
  depth: 0,
  iterationId: null,
  modelProfile: 'model-a',
  configRevision: 0,
  criteriaVersionId: null,
  status: 'succeeded',
  activity: null,
  waitingOn: null,
  modelCallIds: [],
  error: null,
  ...extra,
});

describe('run canvas layout (C-065)', () => {
  it('[TC-OBS-001-H] uses the saved layout when it places every node of the run', () => {
    const { definition, layout } = team();
    const result = runCanvasLayout(definition, layout);
    expect(result.source).toBe('saved');
    expect(result.nodes).toEqual(layout);
  });

  it('[TC-OBS-001-N] arranges every node itself when the saved layout misses one', () => {
    const { definition, layout } = team();
    const { output: _missing, ...partial } = layout;
    for (const saved of [partial, null]) {
      const result = runCanvasLayout(definition, saved);
      expect(result.source).toBe('auto');
      for (const node of definition.nodes) expect(result.nodes[node.id]).toBeDefined();
      const spots = definition.nodes.map(
        (n) => `${result.nodes[n.id]?.x},${result.nodes[n.id]?.y}`,
      );
      expect(new Set(spots).size).toBe(spots.length);
      // Loop members sit inside their Loop's area.
      const loop = result.nodes.review_loop;
      for (const node of definition.nodes) {
        if (!('loopId' in node) || node.loopId !== 'review_loop') continue;
        const box = result.nodes[node.id];
        expect(box && loop?.width && loop.height).toBeTruthy();
        if (!box || !loop?.width || !loop.height) continue;
        expect(box.x).toBeGreaterThan(loop.x);
        expect(box.y).toBeGreaterThan(loop.y);
        expect(box.x).toBeLessThan(loop.x + loop.width);
        expect(box.y).toBeLessThan(loop.y + loop.height);
      }
    }
  });

  it('[TC-OBS-001-N] ignores saved positions of nodes the run does not have', () => {
    const { definition, layout } = team();
    const result = runCanvasLayout(definition, { ...layout, gone: { x: 1, y: 1 } });
    expect(result.source).toBe('saved');
    expect(result.nodes.gone).toBeUndefined();
  });
});

function renderCanvas(
  definition: CorralDefinition,
  projection: RunProjection,
  onSelectNode = vi.fn(),
) {
  const session = sessionStore({ runId: 'run_canvas', definition, projection });
  const layout = runCanvasLayout(definition, team().layout);
  let commits = 0;
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <Profiler id="run-canvas" onRender={() => commits++}>
        <RunCanvas
          session={session}
          definition={definition}
          layout={layout}
          selectedNodeId={null}
          onSelectNode={onSelectNode}
        />
      </Profiler>
    </IntlProvider>,
  );
  return { view, session, commits: () => commits, reset: () => (commits = 0) };
}

describe('RunCanvas (C-065)', () => {
  it('[TC-OBS-001-H] shows how many executions each node had and reports node clicks', async () => {
    const { definition } = team();
    const onSelectNode = vi.fn();
    renderCanvas(
      definition,
      projectionWith({
        executions: {
          w1: execution('w1', 'write'),
          w2: execution('w2', 'write', { status: 'active' }),
        },
        executionOrder: ['w1', 'w2'],
        nodeExecutions: { write: ['w1', 'w2'] },
      }),
      onSelectNode,
    );
    await act(async () => {});
    const writer = document.querySelector('.react-flow__node[data-id="write"]');
    expect(writer?.textContent).toContain('2 executions');
    expect(writer?.querySelector('[data-run-status]')?.getAttribute('data-run-status')).toBe(
      'active',
    );
    fireEvent.click(writer as Element);
    expect(onSelectNode).toHaveBeenCalledWith('write');
    expect(screen.getByRole('application', { name: 'Run graph' })).toBeTruthy();
  });

  it('[TC-OBS-001-N] is read-only: nodes cannot be dragged and ports cannot be connected', async () => {
    const { definition } = team();
    renderCanvas(definition, projectionWith({}));
    await act(async () => {});
    expect(document.querySelectorAll('.react-flow__node').length).toBe(definition.nodes.length);
    expect(document.querySelectorAll('.react-flow__node.draggable').length).toBe(0);
    expect(document.querySelectorAll('.react-flow__handle.connectable').length).toBe(0);
    expect(document.querySelector('.react-flow__resize-control')).toBeNull();
  });

  it('[TC-UX-002-N] run updates that leave node statuses alone do not re-render it', async () => {
    const { definition } = team();
    const harness = renderCanvas(definition, projectionWith({}));
    await act(async () => {});
    harness.reset();
    await act(async () => {
      for (let seq = 1; seq <= 300; seq++) {
        const current = harness.session.getState().projection ?? projectionWith({});
        harness.session.setState({
          projection: { ...current, lastSeq: seq },
          streams: { call_1: { text: `chunk ${seq}`, next: seq, broken: false } },
        });
      }
    });
    expect(harness.commits()).toBe(0);
  });
});

describe('steer target (C-066)', () => {
  it('[TC-OBS-001-N] an execution the run does not have is not replaced by another one', () => {
    const session = sessionStore({
      runId: 'run_target',
      projection: projectionWith({
        executions: { w1: execution('w1', 'write', { status: 'active' }) },
        executionOrder: ['w1'],
      }),
    });
    const missing = renderHook(() => useSteerTarget(session, 'exec_9999'));
    expect(missing.result.current).toBeNull();
    const fallback = renderHook(() => useSteerTarget(session, null));
    expect(fallback.result.current?.executionId).toBe('w1');
  });
});
