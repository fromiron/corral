import type { RunProjection } from '@corral/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fitBounds, ZOOM } from '../src/components/GraphViewport.tsx';
import { RUN_GRAPH_FIT, RunCanvas } from '../src/components/RunCanvas.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import type { RunAgentGraph } from '../src/run/agent-graph.ts';
import { layoutRunAgents, TILE } from '../src/run/agent-graph-layout.ts';
import { projectionWith, researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';

const pane = { width: 1100, height: 620 };
const observers = new Set<() => void>();

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => pane.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => pane.height);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        observers.add(this.callback);
      }
      unobserve() {}
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function graphOf(count: number): RunAgentGraph {
  const ids = ['lead', ...Array.from({ length: count - 1 }, (_, i) => `w${i}`)];
  return {
    nodes: ids.map((id) => ({
      id,
      label: id,
      executionIds: [id],
      summary: { status: 'done', counts: { done: 1 }, previousFailures: 0 },
      lead: id === 'lead',
    })),
    relations: ids.slice(1).map((id) => ({
      id: `lead-${id}`,
      source: 'lead',
      target: id,
      kind: 'delegate',
      count: 1,
      activeCount: 0,
      failedCount: 0,
      executionIds: [],
      artifactVersionIds: [],
    })),
  };
}

function boundsOf(graph: RunAgentGraph) {
  const points = [...layoutRunAgents(graph).values()];
  return {
    minX: Math.min(...points.map((p) => p.x)) - TILE.halfWidth,
    maxX: Math.max(...points.map((p) => p.x)) + TILE.halfWidth,
    minY: Math.min(...points.map((p) => p.y)) - TILE.markHalf,
    maxY: Math.max(...points.map((p) => p.y)) + TILE.labelBottom,
  };
}

describe('run graph fit', () => {
  it('draws a small run large, but never past the fit zoom', () => {
    for (const count of [1, 4]) {
      const view = fitBounds(boundsOf(graphOf(count)), pane.width, pane.height, RUN_GRAPH_FIT);
      expect(view.k).toBeGreaterThan(1);
      expect(view.k).toBeLessThanOrEqual(RUN_GRAPH_FIT.maxZoom);
    }
  });

  it('still shows a twenty-agent run whole, inside the margin, above the smallest zoom', () => {
    const bounds = boundsOf(graphOf(20));
    const view = fitBounds(bounds, pane.width, pane.height, RUN_GRAPH_FIT);
    expect(view.k).toBeLessThan(1);
    expect(view.k).toBeGreaterThanOrEqual(ZOOM.min);
    const left = bounds.minX * view.k + view.x;
    const right = bounds.maxX * view.k + view.x;
    const top = bounds.minY * view.k + view.y;
    const bottom = bounds.maxY * view.k + view.y;
    expect(left).toBeGreaterThanOrEqual(RUN_GRAPH_FIT.padding - 0.5);
    expect(right).toBeLessThanOrEqual(pane.width - RUN_GRAPH_FIT.padding + 0.5);
    expect(top).toBeGreaterThanOrEqual(RUN_GRAPH_FIT.padding - 0.5);
    expect(bottom).toBeLessThanOrEqual(pane.height - RUN_GRAPH_FIT.padding + 0.5);
  });

  it('fits on first display and on request only: new agents and a narrower pane keep the view', async () => {
    const { definition } = researchTeamDraft();
    const execution = (
      executionId: string,
      nodeId: string,
      parentExecutionId: string | null = null,
    ): RunProjection['executions'][string] => ({
      executionId,
      nodeId,
      taskId: `task_${executionId}`,
      attemptNo: 1,
      parentExecutionId,
      previousExecutionId: null,
      depth: parentExecutionId ? 1 : 0,
      iterationId: null,
      modelProfile: 'model-a',
      configRevision: 0,
      criteriaVersionId: null,
      status: 'active',
      activity: null,
      waitingOn: null,
      modelCallIds: [],
      error: null,
    });
    const session = sessionStore({
      runId: 'run_fit',
      definition,
      projection: projectionWith({
        executions: { root: execution('root', 'research') },
        executionOrder: ['root'],
        nodeExecutions: { research: ['root'] },
      }),
    });
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunCanvas
          session={session}
          definition={definition}
          selectedNodeId={null}
          onSelectNode={() => {}}
        />
      </IntlProvider>,
    );
    await act(async () => {});
    const stage = () => document.querySelector<HTMLElement>('[data-graph-stage]')?.style.transform;
    const scale = () => Number(/scale\(([\d.]+)\)/.exec(stage() ?? '')?.[1]);
    const first = stage();
    expect(scale()).toBe(RUN_GRAPH_FIT.maxZoom);
    // A delegate arrives: it is placed, and the view stays where it was.
    await act(async () => {
      session.setState({
        projection: projectionWith({
          executions: {
            root: execution('root', 'research'),
            helper: execution('helper', 'helper', 'root'),
          },
          executionOrder: ['root', 'helper'],
          nodeExecutions: { research: ['root'], helper: ['helper'] },
        }),
      });
    });
    expect(document.querySelector('[data-agent-id="helper"]')).not.toBeNull();
    expect(stage()).toEqual(first);
    // A panel opens beside the graph: the zoom stays and the view keeps its centre.
    pane.width = 740;
    await act(async () => {
      for (const callback of observers) callback();
    });
    expect(scale()).toBe(RUN_GRAPH_FIT.maxZoom);
    expect(stage()).not.toEqual(first);
    // Fit on request frames both agents in the narrower pane.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Fit view' })));
    expect(scale()).toBeLessThanOrEqual(RUN_GRAPH_FIT.maxZoom);
    expect(stage()).not.toEqual(first);
  });
});
