import type { ArtifactVersionView, ExecutionView, ModelCallView } from '@corral/core';
import { render } from '@testing-library/react';
import type { Edge } from '@xyflow/react';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { RunCanvas } from '../src/components/RunCanvas.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
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

const rendered = vi.hoisted(() => ({ edges: [] as Edge[] }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  ReactFlow: ({ edges }: { edges: Edge[] }) => {
    rendered.edges = edges;
    return null;
  },
}));

function execution(id: string, nodeId: string, parentExecutionId: string | null): ExecutionView {
  return {
    executionId: id,
    nodeId,
    taskId: `task_${id}`,
    attemptNo: 1,
    parentExecutionId,
    previousExecutionId: null,
    depth: parentExecutionId ? 1 : 0,
    iterationId: null,
    modelProfile: 'model-a',
    configRevision: 0,
    criteriaVersionId: null,
    status: 'succeeded',
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: null,
  };
}

it('renders only observed directed relations with distinct accessible names', () => {
  const { definition } = researchTeamDraft();
  const author = execution('author', 'research', null);
  const helper = execution('helper', 'helper', 'author');
  const responder = execution('responder', 'respond', 'author');
  const artifact: ArtifactVersionView = {
    artifactVersionId: 'notes',
    artifactId: 'notes',
    version: 1,
    parentVersionId: null,
    name: 'Notes',
    contract: 'notes',
    contentHash: 'hash',
    byteLength: 5,
    authorExecutionId: 'author',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
    bodyAvailable: false,
  };
  const modelCall: ModelCallView = {
    modelCallId: 'call',
    executionId: 'helper',
    contextSnapshotId: 'context',
    profile: 'model-a',
    configRevision: 0,
    directiveIds: [],
    inputArtifactVersionIds: ['notes'],
    finished: true,
    usage: null,
    rawUsage: null,
    certainty: null,
  };
  const projection = projectionWith({
    executions: { author, helper, responder },
    executionOrder: ['author', 'helper', 'responder'],
    nodeExecutions: { research: ['author'], helper: ['helper'], respond: ['responder'] },
    questions: {
      q: {
        questionId: 'q',
        taskId: 'task_responder',
        senderExecutionId: 'author',
        targetNodeId: 'respond',
        targetRoleId: 'researcher',
        body: 'Private question',
        artifactRefs: [],
        deadline: '2026-11-07T00:00:00.000Z',
        status: 'answered',
        answer: { responderExecutionId: 'responder', body: 'Private answer', evidenceRefs: [] },
      },
    },
    artifacts: { notes: artifact },
    artifactReads: { helper: ['notes'] },
    modelCalls: { call: modelCall },
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunCanvas
        session={sessionStore({ runId: 'run_canvas', definition, projection })}
        definition={definition}
        selectedNodeId={null}
        onSelectNode={() => {}}
      />
    </IntlProvider>,
  );
  // Different kinds sharing the same direction may be presented on one line.
  expect(rendered.edges).toHaveLength(3);
  const edge = (source: string, target: string, name: RegExp) =>
    rendered.edges.find(
      (item) => item.source === source && item.target === target && name.test(item.ariaLabel ?? ''),
    );
  for (const [source, target, name] of [
    ['research', 'helper', /delegat/i],
    ['research', 'respond', /question|ask/i],
    ['respond', 'research', /answer|repl/i],
    ['research', 'helper', /read/i],
    ['research', 'helper', /input/i],
  ] as const) {
    expect(edge(source, target, name)).toBeDefined();
  }
  expect(rendered.edges.every((item) => item.ariaLabel?.includes('1'))).toBe(true);
  expect(rendered.edges.some((item) => item.source === 'respond' && item.target === 'helper')).toBe(
    false,
  );
});
