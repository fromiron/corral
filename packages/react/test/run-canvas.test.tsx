import type { CorralDefinition, ModelProfileSnapshot } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RunCanvas } from '../src/components/RunCanvas.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import * as agentGraph from '../src/run/agent-graph.ts';
import { runCanvasLayout } from '../src/run/layout.ts';
import { useSteerTarget } from '../src/run/steer-target.ts';
import { projectionWith, researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterAll(() => vi.restoreAllMocks());

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

const model = (profile: string, modelId: string, provider = 'openai'): ModelProfileSnapshot => ({
  profile,
  provider,
  modelId,
  auth: 'mock',
});

const modelPatch = (
  patchId: string,
  nodeId: string,
  revision: number,
  snapshot: ModelProfileSnapshot,
): RunProjection['patches'][string] => ({
  patchId,
  kind: 'node_future',
  scope: { nodeId },
  before: {},
  after: { modelProfile: snapshot.profile, modelSnapshot: snapshot },
  controlRevision: revision,
  executionIds: [],
  iterationIds: [],
});

describe('run canvas layout', () => {
  it('uses the saved layout when it places every node of the run', () => {
    const { definition, layout } = team();
    const result = runCanvasLayout(definition, layout);
    expect(result.source).toBe('saved');
    expect(result.nodes).toEqual(layout);
  });

  it('arranges every node itself when the saved layout misses one', () => {
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

  it('ignores saved positions of nodes the run does not have', () => {
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
  let commits = 0;
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <Profiler id="run-canvas" onRender={() => commits++}>
        <RunCanvas
          session={session}
          definition={definition}
          selectedNodeId={null}
          onSelectNode={onSelectNode}
        />
      </Profiler>
    </IntlProvider>,
  );
  return { view, session, commits: () => commits, reset: () => (commits = 0) };
}

describe('RunCanvas', () => {
  it('waits for the initial replay prefix before mounting observed nodes', async () => {
    const { definition } = team();
    const projection = projectionWith({
      executions: { writer: execution('writer', 'write') },
      executionOrder: ['writer'],
      nodeExecutions: { write: ['writer'] },
    });
    const session = sessionStore({
      runId: 'run_canvas',
      definition,
      projection,
      initialLoadSeq: null,
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
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(0);
    await act(async () => session.setState({ initialLoadSeq: 3 }));
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(0);
    await act(async () => session.setState({ initialLoadSeq: undefined }));
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(1);
    expect(document.querySelector('.react-flow__node[data-id="write"]')).not.toBeNull();
  });

  it('first arranges the complete initial prefix instead of retaining partial replay positions', async () => {
    const { definition } = team();
    const root = execution('root', 'research', { status: 'active' });
    const helper = execution('helper', 'helper', { parentExecutionId: 'root' });
    const writer = execution('writer', 'write', { parentExecutionId: 'root' });
    const partial = projectionWith({
      executions: { root, helper },
      executionOrder: ['root', 'helper'],
      nodeExecutions: { research: ['root'], helper: ['helper'] },
    });
    const complete = projectionWith({
      executions: { root, helper, writer },
      executionOrder: ['root', 'helper', 'writer'],
      nodeExecutions: { research: ['root'], helper: ['helper'], write: ['writer'] },
    });
    const session = sessionStore({
      runId: 'run_canvas',
      definition,
      projection: partial,
      initialLoadSeq: 3,
    });
    const canvas = (owner: typeof session) => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunCanvas
          session={owner}
          definition={definition}
          selectedNodeId={null}
          onSelectNode={() => {}}
        />
      </IntlProvider>
    );
    const positions = () =>
      Object.fromEntries(
        [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => [
          node.dataset.id,
          node.style.transform,
        ]),
      );
    const view = render(canvas(session));
    await act(async () => session.setState({ projection: complete, initialLoadSeq: undefined }));
    const afterReplay = positions();
    expect(Object.keys(afterReplay).sort()).toEqual(['helper', 'research', 'write']);
    view.unmount();
    render(canvas(sessionStore({ runId: 'run_canvas', definition, projection: complete })));
    await act(async () => {});
    expect(positions()).toEqual(afterReplay);
  });

  it('shows one observed agent with its model and retry count and reports its exact node', async () => {
    const { definition } = team();
    const onSelectNode = vi.fn();
    renderCanvas(
      definition,
      projectionWith({
        executions: {
          w1: execution('w1', 'write', {
            taskId: 'write_task',
            status: 'failed',
            modelProfile: 'observed-profile',
          }),
          w2: execution('w2', 'write', {
            taskId: 'write_task',
            attemptNo: 2,
            previousExecutionId: 'w1',
            status: 'active',
            modelProfile: 'observed-profile',
          }),
        },
        executionOrder: ['w1', 'w2'],
        nodeExecutions: { write: ['w1', 'w2'] },
      }),
      onSelectNode,
    );
    await act(async () => {});
    const writer = document.querySelector('.react-flow__node[data-id="write"]');
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(1);
    expect(writer?.textContent).toContain(
      definition.nodes.find((node) => node.id === 'write')?.label,
    );
    expect(writer?.textContent).toContain('observed-profile');
    expect(writer?.textContent).not.toContain('model-a');
    expect(writer?.textContent).toContain('2 executions');
    expect(writer?.querySelector('[data-run-status]')?.getAttribute('data-run-status')).toBe(
      'active',
    );
    const button = writer?.querySelector('button');
    expect(button).toBeTruthy();
    fireEvent.click(button as Element);
    expect(onSelectNode).toHaveBeenCalledWith('write');
    expect(screen.getByRole('application', { name: 'Run graph' })).toBeTruthy();
  });

  it('shows concurrent waiting and failed tasks without drawing definition loop nodes', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: {
          failed: execution('failed', 'write', { status: 'failed' }),
          waiting: execution('waiting', 'write', { status: 'waiting_message' }),
        },
        executionOrder: ['failed', 'waiting'],
        nodeExecutions: { write: ['failed', 'waiting'] },
        iterations: {
          round: {
            iterationId: 'round',
            loopNodeId: 'review_loop',
            no: 1,
            criteriaVersionId: 'criteria',
            outcome: 'revise',
          },
        },
        loopIterations: { review_loop: ['round'] },
      }),
    );
    await act(async () => {});
    const writer = document.querySelector('.react-flow__node[data-id="write"]');
    expect(writer?.textContent).toContain('Waiting for a reply');
    expect(writer?.textContent).toContain('Failed: 1');
    expect(document.querySelector('.react-flow__node[data-id="review_loop"]')).toBeNull();
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(1);
  });

  it('names the model resolved for the observed execution profile', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: { writer: execution('writer', 'write', { modelProfile: 'used-profile' }) },
        executionOrder: ['writer'],
        nodeExecutions: { write: ['writer'] },
        modelProfiles: {
          'used-profile': {
            profile: 'used-profile',
            provider: 'openai',
            modelId: 'recorded-model',
            auth: 'mock',
          },
        },
      }),
    );
    await act(async () => {});
    const writer = document.querySelector('.react-flow__node[data-id="write"]');
    expect(writer?.textContent).toContain('recorded-model');
    expect(writer?.textContent).not.toContain('model-a');
  });

  it('uses the latest matching node patch no later than the observed execution revision', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: {
          writer: execution('writer', 'write', { modelProfile: 'patched', configRevision: 2 }),
        },
        executionOrder: ['writer'],
        nodeExecutions: { write: ['writer'] },
        modelProfiles: { 'model-a': model('model-a', 'initial-model') },
        patches: {
          future: modelPatch('future', 'write', 3, model('patched', 'future-model')),
          unrelated: modelPatch('unrelated', 'review', 2, model('patched', 'other-node-model')),
          latest: modelPatch('latest', 'write', 2, model('patched', 'patched-model')),
          older: modelPatch('older', 'write', 1, model('patched', 'older-model')),
        },
      }),
    );
    await act(async () => {});
    const writer = document.querySelector('.react-flow__node[data-id="write"]');
    expect(writer?.textContent).toContain('patched-model');
    expect(writer?.textContent).not.toContain('future-model');
    expect(writer?.textContent).not.toContain('other-node-model');
  });

  it('counts two actual models when one profile was changed between executions', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: {
          old: execution('old', 'write', { configRevision: 0 }),
          next: execution('next', 'write', { configRevision: 1 }),
        },
        executionOrder: ['old', 'next'],
        nodeExecutions: { write: ['old', 'next'] },
        modelProfiles: { 'model-a': model('model-a', 'first-model') },
        patches: { change: modelPatch('change', 'write', 1, model('model-a', 'second-model')) },
      }),
    );
    await act(async () => {});
    const writer = document.querySelector('.react-flow__node[data-id="write"]');
    expect(writer?.textContent).toContain('2 models');
    expect(writer?.textContent).not.toContain('first-model');
  });

  it('deduplicates profiles resolved to the same provider and actual model', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: {
          a: execution('a', 'write', { modelProfile: 'profile-a' }),
          b: execution('b', 'write', { modelProfile: 'profile-b' }),
        },
        executionOrder: ['a', 'b'],
        nodeExecutions: { write: ['a', 'b'] },
        modelProfiles: {
          'profile-a': model('profile-a', 'same-model'),
          'profile-b': model('profile-b', 'same-model'),
        },
      }),
    );
    await act(async () => {});
    const writer = document.querySelector('.react-flow__node[data-id="write"]');
    expect(writer?.textContent).toContain('same-model');
    expect(writer?.textContent).not.toContain('2 models');
  });

  it('uses a model call revision when resolving its observed profile', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: {
          writer: execution('writer', 'write', { configRevision: 0, modelCallIds: ['call'] }),
        },
        executionOrder: ['writer'],
        nodeExecutions: { write: ['writer'] },
        modelProfiles: { 'model-a': model('model-a', 'before-model') },
        patches: { change: modelPatch('change', 'write', 1, model('model-a', 'called-model')) },
        modelCalls: {
          call: {
            modelCallId: 'call',
            executionId: 'writer',
            contextSnapshotId: 'context',
            profile: 'model-a',
            configRevision: 1,
            directiveIds: [],
            inputArtifactVersionIds: [],
            finished: true,
            usage: null,
            rawUsage: null,
            certainty: null,
          },
        },
      }),
    );
    await act(async () => {});
    const writer = document.querySelector('.react-flow__node[data-id="write"]');
    expect(writer?.textContent).toContain('called-model');
    expect(writer?.textContent).not.toContain('before-model');
  });

  it('uses the OpenAI mark for an observed openai-codex provider', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: { writer: execution('writer', 'write') },
        executionOrder: ['writer'],
        nodeExecutions: { write: ['writer'] },
        modelProfiles: { 'model-a': model('model-a', 'recorded-model', 'openai-codex') },
      }),
    );
    await act(async () => {});
    const button = document.querySelector('.react-flow__node[data-id="write"] button');
    expect(button?.querySelector('svg[viewBox="0 0 24 24"]')).not.toBeNull();
  });

  it('shows a recorded question target as requested even before that agent has an execution', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: { writer: execution('writer', 'write', { status: 'waiting_message' }) },
        executionOrder: ['writer'],
        nodeExecutions: { write: ['writer'] },
        questions: {
          question: {
            questionId: 'question',
            taskId: 'answer_task',
            senderExecutionId: 'writer',
            targetNodeId: 'respond',
            targetRoleId: 'responder',
            body: 'Private question body',
            artifactRefs: [],
            deadline: '2026-11-07T00:00:00.000Z',
            status: 'open',
            answer: null,
          },
        },
      }),
    );
    await act(async () => {});
    expect(
      [...document.querySelectorAll('.react-flow__node')]
        .map((node) => node.getAttribute('data-id'))
        .sort(),
    ).toEqual(['respond', 'write']);
    const target = document.querySelector('.react-flow__node[data-id="respond"]');
    expect(target?.textContent).toMatch(/requested/i);
    expect(target?.textContent).not.toContain('model-a');
    const senderButton = document.querySelector('.react-flow__node[data-id="write"] button');
    const targetButton = target?.querySelector('button');
    const from = definition.nodes.find((node) => node.id === 'write')?.label;
    const to = definition.nodes.find((node) => node.id === 'respond')?.label;
    expect(senderButton).toHaveAccessibleDescription(`${from} → ${to}: Question 1`);
    expect(targetButton).toHaveAccessibleDescription(`${from} → ${to}: Question 1`);
    expect(['active', 'model', 'tool']).not.toContain(
      target?.querySelector('[data-run-status]')?.getAttribute('data-run-status'),
    );
    expect(screen.queryByText('Private question body')).toBeNull();
  });

  it('shows an empty state instead of a definition graph when no agent work was observed', async () => {
    const { definition } = team();
    renderCanvas(definition, projectionWith({}));
    await act(async () => {});
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(0);
    expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(0);
  });

  it('is read-only: nodes cannot be dragged and ports cannot be connected', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: { writer: execution('writer', 'write') },
        executionOrder: ['writer'],
        nodeExecutions: { write: ['writer'] },
      }),
    );
    await act(async () => {});
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(1);
    expect(document.querySelectorAll('.react-flow__node.draggable').length).toBe(0);
    expect(document.querySelectorAll('.react-flow__handle.connectable').length).toBe(0);
    expect(document.querySelector('.react-flow__resize-control')).toBeNull();
  });

  it('run updates that leave node statuses alone do not re-render it', async () => {
    const { definition } = team();
    const harness = renderCanvas(
      definition,
      projectionWith({
        executions: { writer: execution('writer', 'write') },
        executionOrder: ['writer'],
        nodeExecutions: { write: ['writer'] },
      }),
    );
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

  it('does not rebuild relationships for streams alone, but updates them for a changed projection', async () => {
    const build = vi.spyOn(agentGraph, 'buildRunAgentGraph');
    try {
      const { definition } = team();
      const harness = renderCanvas(
        definition,
        projectionWith({
          executions: { writer: execution('writer', 'write') },
          executionOrder: ['writer'],
          nodeExecutions: { write: ['writer'] },
        }),
      );
      await act(async () => {});
      build.mockClear();
      await act(async () => {
        for (let seq = 1; seq <= 300; seq++) {
          harness.session.setState({
            streams: { call_1: { text: `chunk ${seq}`, next: seq, broken: false } },
          });
        }
      });
      expect(build.mock.calls.length).toBe(0);
      const previous = harness.session.getState().projection;
      if (!previous) throw new Error('Missing projection');
      await act(async () => {
        harness.session.setState({
          projection: {
            ...previous,
            executions: {
              ...previous.executions,
              writer: execution('writer', 'write', { status: 'active' }),
            },
          },
        });
      });
      expect(build).toHaveBeenCalled();
      expect(
        document.querySelector('.react-flow__node[data-id="write"] [data-run-status]'),
      ).toHaveAttribute('data-run-status', 'active');
      build.mockClear();
      const renamed: CorralDefinition = {
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === 'write' ? { ...node, label: 'Renamed writer' } : node,
        ),
      };
      harness.view.rerender(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Profiler id="run-canvas" onRender={() => {}}>
            <RunCanvas
              session={harness.session}
              definition={renamed}
              selectedNodeId={null}
              onSelectNode={() => {}}
            />
          </Profiler>
        </IntlProvider>,
      );
      expect(build.mock.calls.length).toBeGreaterThan(0);
      expect(document.querySelector('.react-flow__node[data-id="write"]')?.textContent).toContain(
        'Renamed writer',
      );
    } finally {
      build.mockRestore();
    }
  });
});

describe('steer target', () => {
  it('an execution the run does not have is not replaced by another one', () => {
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
