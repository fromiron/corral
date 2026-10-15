import { act, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { Profiler } from 'react';
import { IntlProvider } from 'use-intl';
import { beforeAll, describe, expect, it } from 'vitest';
import { CorralCanvas } from '../src/components/CorralCanvas.tsx';
import { StudioStoresProvider } from '../src/context.tsx';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';

beforeAll(() => {
  // jsdom has no layout; React Flow only needs these to exist.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe('canvas render budget (C-016, Spec §10.3)', () => {
  it('[TC-UX-002-N] run updates that do not change a node status do not re-render the canvas', async () => {
    const editor = createEditorStore(researchTeamDraft());
    const session = sessionStore({ runId: 'run_budget', projection: projectionWith({}) });
    let commits = 0;
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <StudioStoresProvider editor={editor} session={session}>
          <ReactFlowProvider>
            <Profiler id="canvas" onRender={() => commits++}>
              <CorralCanvas />
            </Profiler>
          </ReactFlowProvider>
        </StudioStoresProvider>
      </IntlProvider>,
    );
    await act(async () => {});
    commits = 0;

    // 500 committed facts that leave every node's aggregate status as it is.
    await act(async () => {
      for (let seq = 1; seq <= 500; seq++) {
        const current = session.getState().projection ?? projectionWith({});
        session.setState({
          projection: {
            ...current,
            lastSeq: seq,
            modelCalls: { ...current.modelCalls, [`call_${seq}`]: {} as never },
          },
        });
      }
    });
    expect(commits).toBe(0);

    // A real status change does reach the node that owns it.
    await act(async () => {
      const current = session.getState().projection ?? projectionWith({});
      session.setState({
        projection: {
          ...current,
          nodeExecutions: { research: ['exec_x'] },
          executions: {
            exec_x: {
              executionId: 'exec_x',
              nodeId: 'research',
              taskId: 'task_x',
              attemptNo: 1,
              parentExecutionId: null,
              previousExecutionId: null,
              depth: 0,
              iterationId: null,
              modelProfile: 'model-a',
              configRevision: 0,
              criteriaVersionId: null,
              status: 'active',
              activity: 'model',
              waitingOn: null,
              modelCallIds: [],
              error: null,
            },
          },
        },
      });
    });
    expect(commits).toBeGreaterThan(0);
  });
});
