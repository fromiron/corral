import { RunEvent } from '@corral/contracts';
import { type ArtifactVersionView, applyEvent, emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { ArtifactViewer } from '../src/components/ArtifactViewer.tsx';
import { BudgetInspector } from '../src/components/BudgetInspector.tsx';
import { ExecutionTranscript } from '../src/components/ExecutionTranscript.tsx';
import { RunCanvas } from '../src/components/RunCanvas.tsx';
import { RunResults } from '../src/components/RunResults.tsx';
import { ExecutionTree, RunOutput } from '../src/components/RunView.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { RunDisplayProvider, type RunDisplaySnapshot, useRunDisplay } from '../src/run/display.tsx';
import { historicalStreams } from '../src/run/history.ts';
import { runCanvasLayout } from '../src/run/layout.ts';
import { nodeRunStatus } from '../src/run/selectors.ts';
import { sessionStore } from '../src/stories/fixtures.tsx';

function artifact(id: string): ArtifactVersionView {
  return {
    artifactVersionId: id,
    artifactId: id,
    version: 1,
    parentVersionId: null,
    name: id,
    contract: 'draft',
    contentHash: `hash-${id}`,
    byteLength: 12,
    authorExecutionId: 'exec_past',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: false,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
  };
}

function fixture() {
  const definition = linearCorral(['worker']);
  const records: RunEvent[] = [];
  const add = (type: RunEvent['type'], payload: Record<string, unknown>) =>
    records.push(
      RunEvent.parse({
        schemaVersion: '0.1',
        eventId: `evt_${records.length + 1}`,
        runId: 'run_display',
        runSeq: records.length + 1,
        recordedAt: '2026-10-15T00:00:00.000Z',
        actor: { kind: 'runtime', id: 'runtime' },
        causedByEventIds: [],
        executionId: payload.executionId,
        type,
        payload,
      }),
    );
  const created = (executionId: string) => ({
    executionId,
    nodeId: 'worker',
    taskId: `task_${executionId}`,
    attemptNo: 1,
    parentExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
  });
  const prepared = (modelCallId: string) => ({
    executionId: 'exec_past',
    modelCallId,
    contextSnapshotId: `ctx_${modelCallId}`,
    profile: 'model-a',
    configRevision: 0,
    directiveIds: [],
    inputArtifactVersionIds: [],
  });
  const finished = (modelCallId: string) => ({
    executionId: 'exec_past',
    modelCallId,
    responseRef: `response_${modelCallId}`,
    rawUsage: null,
    normalizedUsage: {
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
    certainty: 'reported',
  });
  add('execution.created', created('exec_past'));
  add('execution.state_changed', {
    executionId: 'exec_past',
    from: 'queued',
    to: 'active',
    activity: 'model',
    waitingOn: null,
  });
  add('model.request_prepared', prepared('call_past'));
  add('model.finished', finished('call_past'));
  add('model.request_prepared', prepared('call_open'));
  const events = [...records];
  const past = records.reduce(applyEvent, emptyProjection('run_display'));
  past.artifacts = { past_result: artifact('past_result') };
  past.budget = { ...past.budget, spent: 42 };
  add('model.finished', finished('call_open'));
  add('execution.settled', {
    executionId: 'exec_past',
    outcome: 'succeeded',
    terminationMode: 'normal',
  });
  add('execution.created', created('exec_future'));
  add('execution.settled', {
    executionId: 'exec_future',
    outcome: 'failed',
    terminationMode: 'normal',
    error: 'Future failure',
  });
  const live = records.reduce(applyEvent, emptyProjection('run_display'));
  live.status = 'succeeded';
  live.artifacts = { ...past.artifacts, future_result: artifact('future_result') };
  live.output = { nodeId: 'out', artifactVersionIds: ['future_result'] };
  live.budget = { ...live.budget, spent: 999 };
  const streams = {
    call_past: { text: 'PAST RESPONSE', next: 1, broken: false, completed: true },
    call_open: { text: 'FUTURE RESPONSE', next: 1, broken: false, completed: true },
  };
  const session = sessionStore({
    runId: 'run_display',
    definition,
    projection: live,
    events: records,
    streams,
    outputText: 'FUTURE OUTPUT',
    artifactTexts: { past_result: 'PAST RESULT', future_result: 'FUTURE RESULT' },
  });
  const snapshot: RunDisplaySnapshot = {
    projection: past,
    events,
    streams: historicalStreams(past, streams),
  };
  return { definition, session, snapshot, live };
}

it('graph, tree, calls, results and usage read one prefix while future cache bodies stay hidden', async () => {
  const { definition, session, snapshot } = fixture();
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunDisplayProvider snapshot={snapshot}>
        <RunCanvas
          session={session}
          definition={definition}
          layout={runCanvasLayout(definition, null)}
          selectedNodeId={null}
          onSelectNode={() => {}}
        />
        <section data-testid="tree">
          <ExecutionTree session={session} onSteer={() => {}} />
        </section>
        <ExecutionTranscript session={session} executionId="exec_past" />
        <RunResults session={session} selectedId={null} onSelect={() => {}} />
        <RunOutput session={session} />
        <ArtifactViewer session={session} versionId="future_result" onClose={() => {}} />
        <BudgetInspector session={session} />
      </RunDisplayProvider>
    </IntlProvider>,
  );
  expect(
    view.container
      .querySelector('[data-id="worker"] [data-run-status]')
      ?.getAttribute('data-run-status'),
  ).toBe(nodeRunStatus(snapshot.projection, 'worker'));
  expect(within(screen.getByTestId('tree')).getByTestId('execution-exec_past')).toBeInTheDocument();
  expect(
    within(screen.getByTestId('tree')).queryByTestId('execution-exec_future'),
  ).not.toBeInTheDocument();
  expect(await screen.findByText('PAST RESPONSE')).toBeInTheDocument();
  expect(await screen.findByText('PAST RESULT')).toBeInTheDocument();
  expect(screen.getByText('Confirmed output tokens').nextSibling).toHaveTextContent('42');
  for (const future of ['FUTURE RESPONSE', 'FUTURE RESULT', 'FUTURE OUTPUT', 'Future failure']) {
    expect(screen.queryByText(future)).not.toBeInTheDocument();
  }
  expect(session.getState().projection?.budget.spent).toBe(999);
  expect(session.getState().events).toHaveLength(9);
});

it('outside a display provider the same hook follows the original live session', () => {
  const { session, live } = fixture();
  function Current() {
    const spent = useRunDisplay(session, (s) => s.projection?.budget.spent);
    return <output>{spent}</output>;
  }
  render(<Current />);
  expect(screen.getByRole('status')).toHaveTextContent('999');
  act(() =>
    session.setState({
      projection: {
        ...live,
        budget: { ...live.budget, spent: 1000 },
      },
    }),
  );
  expect(screen.getByRole('status')).toHaveTextContent('1000');
});

it('a fixed snapshot does not rerender for live token and future projection changes', () => {
  const { session, snapshot, live } = fixture();
  let renders = 0;
  function Current() {
    const seq = useRunDisplay(session, (s) => s.projection?.lastSeq);
    renders++;
    return <output>{seq}</output>;
  }
  render(
    <RunDisplayProvider snapshot={snapshot}>
      <Current />
    </RunDisplayProvider>,
  );
  const before = renders;
  act(() =>
    session.setState({
      streams: {},
      projection: { ...live, lastSeq: 10 },
    }),
  );
  expect(screen.getByRole('status')).toHaveTextContent('5');
  expect(renders).toBe(before);
});
