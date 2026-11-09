import type { CorralDefinition, ModelProfileSnapshot } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RunCanvas } from '../src/components/RunCanvas.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import * as agentGraph from '../src/run/agent-graph.ts';
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
    expect(document.querySelectorAll('[data-agent-id]')).toHaveLength(0);
    await act(async () => session.setState({ initialLoadSeq: 3 }));
    expect(document.querySelectorAll('[data-agent-id]')).toHaveLength(0);
    await act(async () => session.setState({ initialLoadSeq: undefined }));
    expect(document.querySelectorAll('[data-agent-id]')).toHaveLength(1);
    expect(document.querySelector('[data-agent-id="write"]')).not.toBeNull();
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
        [...document.querySelectorAll<HTMLElement>('[data-agent-id]')].map((node) => [
          node.dataset.agentId,
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
    const writer = document.querySelector('[data-agent-id="write"]');
    expect(document.querySelectorAll('[data-agent-id]')).toHaveLength(1);
    expect(writer?.textContent).toContain(
      definition.nodes.find((node) => node.id === 'write')?.label,
    );
    expect(writer?.textContent).toContain('observed-profile');
    expect(writer?.textContent).not.toContain('model-a');
    expect(writer?.textContent).toContain('2 executions');
    expect(writer?.querySelector('[data-run-status]')?.getAttribute('data-run-status')).toBe(
      'active',
    );
    // A working agent keeps the kit's breathing halo behind its mark.
    expect(
      [...(writer?.querySelectorAll('span[aria-hidden="true"]') ?? [])].some((span) =>
        span.getAttribute('style')?.includes('color-mix'),
      ),
    ).toBe(true);
    const button = writer?.querySelector('button');
    expect(button).toBeTruthy();
    fireEvent.click(button as Element);
    expect(onSelectNode).toHaveBeenCalledWith('write', button);
    expect(screen.getByRole('group', { name: 'Run graph' })).toBeTruthy();
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
            parentIterationId: null,
            outcome: 'revise',
          },
        },
        loopIterations: { review_loop: ['round'] },
      }),
    );
    await act(async () => {});
    const writer = document.querySelector('[data-agent-id="write"]');
    expect(writer?.textContent).toContain('Waiting for a reply');
    expect(writer?.textContent).toContain('Failed: 1');
    expect(document.querySelector('[data-agent-id="review_loop"]')).toBeNull();
    expect(document.querySelectorAll('[data-agent-id]')).toHaveLength(1);
  });

  it('breathes an amber halo on an agent awaiting approval and none on a finished one', async () => {
    const { definition } = team();
    renderCanvas(
      definition,
      projectionWith({
        executions: {
          writer: execution('writer', 'write', { status: 'waiting_approval' }),
          reviewer: execution('reviewer', 'review'),
        },
        executionOrder: ['writer', 'reviewer'],
        nodeExecutions: { write: ['writer'], review: ['reviewer'] },
      }),
    );
    await act(async () => {});
    const halo = (id: string) =>
      [...document.querySelectorAll(`[data-agent-id="${id}"] span[aria-hidden="true"]`)]
        .map((span) => span.getAttribute('style') ?? '')
        .find((style) => style.includes('color-mix'));
    expect(halo('write')).toContain('var(--warning)');
    expect(halo('review')).toBeUndefined();
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
    const writer = document.querySelector('[data-agent-id="write"]');
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
    const writer = document.querySelector('[data-agent-id="write"]');
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
    const writer = document.querySelector('[data-agent-id="write"]');
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
    const writer = document.querySelector('[data-agent-id="write"]');
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
    const writer = document.querySelector('[data-agent-id="write"]');
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
    const button = document.querySelector('[data-agent-id="write"] button');
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
      [...document.querySelectorAll('[data-agent-id]')]
        .map((node) => node.getAttribute('data-agent-id'))
        .sort(),
    ).toEqual(['respond', 'write']);
    const target = document.querySelector('[data-agent-id="respond"]');
    expect(target?.textContent).toMatch(/requested/i);
    expect(target?.textContent).not.toContain('model-a');
    const senderButton = document.querySelector('[data-agent-id="write"] button');
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
    expect(document.querySelectorAll('[data-agent-id]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-relation]')).toHaveLength(0);
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
    expect(document.querySelectorAll('[data-agent-id]')).toHaveLength(1);
    expect(document.querySelector('.react-flow')).toBeNull();
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-handleid]')).toHaveLength(0);
  });

  it('draws the kit stage: centre-to-centre edges, elbows from the lead, parallel opposite lines', async () => {
    const { definition } = team();
    const root = execution('root', 'research');
    const helper = execution('helper', 'helper', { parentExecutionId: 'root' });
    const writer = execution('writer', 'write', { parentExecutionId: 'root' });
    renderCanvas(
      definition,
      projectionWith({
        status: 'succeeded',
        executions: { root, helper, writer },
        executionOrder: ['root', 'helper', 'writer'],
        nodeExecutions: { research: ['root'], helper: ['helper'], write: ['writer'] },
        questions: {
          q: {
            questionId: 'q',
            taskId: 'task_answer',
            senderExecutionId: 'helper',
            targetExecutionId: 'writer',
            targetNodeId: 'write',
            targetRoleId: 'writer',
            body: 'Private',
            artifactRefs: [],
            deadline: '2026-11-07T00:00:00.000Z',
            status: 'answered',
            answer: { responderExecutionId: 'writer', body: 'Private', evidenceRefs: [] },
          },
        },
      }),
    );
    await act(async () => {});
    const edge = (source: string, target: string) =>
      document.querySelector<SVGPathElement>(
        `path[data-relation][data-source="${source}"][data-target="${target}"]`,
      );
    const center = (id: string) => {
      const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
        document.querySelector<HTMLElement>(`[data-agent-id="${id}"]`)?.style.transform ?? '',
      );
      if (!match) throw new Error(`Missing ${id} position`);
      return { x: Number(match[1]), y: Number(match[2]) };
    };
    // Edges leave the lead vertically and turn with a rounded corner.
    for (const target of ['helper', 'write']) {
      const d = edge('research', target)?.getAttribute('d') ?? '';
      expect(d).toMatch(/Q/);
      const [x, y] = d.slice(1).split(/[ L]/).map(Number);
      expect(Math.abs((x ?? 0) - center('research').x)).toBeLessThanOrEqual(8);
      expect(y).toBeCloseTo(center('research').y, 0);
    }
    // A question and its answer between the same pair do not paint over each other.
    const ask = edge('helper', 'write')?.getAttribute('d');
    const answer = edge('write', 'helper')?.getAttribute('d');
    expect(ask && answer).toBeTruthy();
    expect(answer).not.toEqual(ask);
    const start = (d: string) => d.slice(1).split(/[ L]/).slice(0, 2).map(Number);
    expect(start(answer ?? '')).not.toEqual(start(ask ?? '').reverse());
    // No ports, handles or arrowheads.
    expect(document.querySelectorAll('marker, [data-handleid]')).toHaveLength(0);
  });

  it('colours work in progress, slowly greys finished relations and never flows a failure', async () => {
    const { definition } = team();
    const root = execution('root', 'research', { status: 'active' });
    const helper = execution('helper', 'helper', { parentExecutionId: 'root', status: 'active' });
    const writer = execution('writer', 'write', { parentExecutionId: 'root' });
    const reviewer = execution('reviewer', 'review', {
      parentExecutionId: 'root',
      status: 'failed',
    });
    const question = {
      questionId: 'q',
      taskId: 'task_answer',
      senderExecutionId: 'writer',
      targetNodeId: 'respond',
      targetRoleId: 'responder',
      body: 'Private',
      artifactRefs: [],
      deadline: '2026-11-07T00:00:00.000Z',
      status: 'open' as const,
      answer: null,
    };
    const live = projectionWith({
      executions: { root, helper, writer, reviewer },
      executionOrder: ['root', 'helper', 'writer', 'reviewer'],
      nodeExecutions: {
        research: ['root'],
        helper: ['helper'],
        write: ['writer'],
        review: ['reviewer'],
      },
      questions: { q: question },
      artifacts: {
        notes: {
          artifactVersionId: 'notes',
          artifactId: 'notes',
          version: 1,
          parentVersionId: null,
          name: 'Notes',
          contract: 'notes',
          contentHash: 'hash',
          byteLength: 5,
          authorExecutionId: 'writer',
          modelCallId: null,
          contextSnapshotId: null,
          submitted: true,
          configRevision: 0,
          criteriaVersionId: null,
          inputArtifactVersionIds: [],
          bodyAvailable: false,
        },
      },
      modelCalls: {
        call: {
          modelCallId: 'call',
          executionId: 'root',
          contextSnapshotId: 'context',
          profile: 'model-a',
          configRevision: 0,
          directiveIds: [],
          inputArtifactVersionIds: ['notes'],
          finished: false,
          usage: null,
          rawUsage: null,
          certainty: null,
        },
      },
    });
    const harness = renderCanvas(definition, live);
    await act(async () => {});
    const path = (source: string, target: string) =>
      document.querySelector(
        `path[data-relation][data-source="${source}"][data-target="${target}"]`,
      );
    const state = (source: string, target: string) =>
      path(source, target)?.getAttribute('data-relation-state');
    expect(state('research', 'helper')).toBe('call');
    expect(state('write', 'research')).toBe('data');
    expect(state('write', 'respond')).toBe('ask');
    expect(state('research', 'review')).toBe('failed');
    expect(state('research', 'write')).toBe('settled');
    expect(path('research', 'helper')?.getAttribute('stroke')).toBe('var(--emphasis)');
    expect(path('write', 'research')?.getAttribute('stroke')).toBe('var(--success)');
    expect(path('write', 'respond')?.getAttribute('stroke')).toBe('var(--warning)');
    expect(path('research', 'review')?.getAttribute('stroke')).toBe('var(--destructive)');
    // Every relation except a failure flows from sender to receiver; finished ones slowly.
    expect(document.querySelectorAll('path.flow-dash:not(.flow-dash-slow)')).toHaveLength(3);
    expect(path('research', 'write')?.classList.contains('flow-dash-slow')).toBe(true);
    expect(path('research', 'review')?.classList.contains('flow-dash')).toBe(false);
    // Reduced motion stops the flow, so each line also carries a direction mark.
    expect(document.querySelectorAll('[data-direction-marker]')).toHaveLength(
      document.querySelectorAll('path[data-relation]').length,
    );
    const legend = () =>
      [...screen.getByRole('list', { name: 'Observed relationships' }).children].map(
        (item) => item.textContent,
      );
    expect(legend()).toEqual(['Call', 'Data', 'Needs you', 'Failed', 'Finished']);
    await act(async () =>
      harness.session.setState({ projection: { ...live, status: 'cancelled' } }),
    );
    expect(document.querySelectorAll('path.flow-dash:not(.flow-dash-slow)')).toHaveLength(0);
    expect(state('research', 'helper')).toBe('settled');
    expect(state('research', 'review')).toBe('failed');
    expect(legend()).toEqual(['Failed', 'Finished']);
  });

  it('labels the selected agent relations with kind, count and direction', async () => {
    const { definition } = team();
    const root = execution('root', 'research');
    const helper = execution('helper', 'helper', { parentExecutionId: 'root' });
    const projection = projectionWith({
      executions: { root, helper },
      executionOrder: ['root', 'helper'],
      nodeExecutions: { research: ['root'], helper: ['helper'] },
    });
    const session = sessionStore({ runId: 'run_canvas', definition, projection });
    const canvas = (selectedNodeId: string | null) => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunCanvas
          session={session}
          definition={definition}
          selectedNodeId={selectedNodeId}
          onSelectNode={() => {}}
        />
      </IntlProvider>
    );
    const view = render(canvas(null));
    await act(async () => {});
    expect(document.querySelectorAll('[data-relation-label]')).toHaveLength(0);
    view.rerender(canvas('helper'));
    const label = document.querySelector('[data-relation-label]');
    expect(label?.textContent).toContain('Delegation 1');
    expect(label?.querySelector('[data-direction]')).not.toBeNull();
  });

  it('pans and zooms the stage without moving agents, and fits only on request', async () => {
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
    const stage = () => document.querySelector<HTMLElement>('[data-graph-stage]');
    const node = () =>
      document.querySelector<HTMLElement>('[data-agent-id="write"]')?.style.transform;
    const initial = stage()?.style.transform;
    const position = node();
    expect(initial).toMatch(/scale\(/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Zoom in' })));
    const zoomed = stage()?.style.transform;
    expect(zoomed).not.toEqual(initial);
    const pane = document.querySelector<HTMLElement>('[data-graph-pane]');
    if (!pane) throw new Error('Missing pane');
    await act(async () => {
      fireEvent.pointerDown(pane, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(pane, { pointerId: 1, clientX: 160, clientY: 130 });
      fireEvent.pointerUp(pane, { pointerId: 1, clientX: 160, clientY: 130 });
    });
    expect(stage()?.style.transform).not.toEqual(zoomed);
    expect(node()).toEqual(position);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Fit view' })));
    expect(stage()?.style.transform).toEqual(initial);
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
      expect(document.querySelector('[data-agent-id="write"] [data-run-status]')).toHaveAttribute(
        'data-run-status',
        'active',
      );
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
      expect(document.querySelector('[data-agent-id="write"]')?.textContent).toContain(
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
