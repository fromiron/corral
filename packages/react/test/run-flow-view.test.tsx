import { type EventOf, RunEvent } from '@corral/contracts';
import { applyEvent, emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { DecisionDetail, RunFlowView } from '../src/components/RunFlowView.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';

function event<K extends RunEvent['type']>(
  seq: number,
  type: K,
  payload: EventOf<K>['payload'],
): EventOf<K> {
  return RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `event_${seq}`,
    runId: 'flow_run',
    runSeq: seq,
    recordedAt: `2026-11-06T00:00:${String(seq).padStart(2, '0')}.000Z`,
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type,
    payload,
  }) as EventOf<K>;
}
const created = (seq: number, id: string, nodeId: string) =>
  event(seq, 'execution.created', {
    executionId: id,
    nodeId,
    taskId: `task_${id}`,
    attemptNo: 1,
    parentExecutionId: null,
    depth: 0,
    iterationId: null,
    modelProfile: 'model-a',
  });
const artifact = (seq: number, id: string, author: string) =>
  event(seq, 'artifact.version_created', {
    artifactId: `artifact_${id}`,
    artifactVersionId: id,
    name: id,
    version: 1,
    parentVersionId: null,
    authorExecutionId: author,
    contract: 'text',
    contentHash: 'a'.repeat(64),
    byteLength: 10,
    modelCallId: null,
    contextSnapshotId: null,
  });
function fixture() {
  const events = [
    created(1, 'research_1', 'research'),
    created(2, 'write_1', 'writer'),
    artifact(3, 'Notes', 'research_1'),
    event(4, 'artifact.read', {
      requestedRef: 'Notes',
      resolvedVersionId: 'Notes',
      consumerExecutionId: 'write_1',
    }),
    event(5, 'model.request_prepared', {
      executionId: 'write_1',
      modelCallId: 'call_write',
      contextSnapshotId: 'context_write',
      profile: 'model-a',
      configRevision: 0,
      directiveIds: [],
      inputArtifactVersionIds: ['Notes'],
    }),
    artifact(6, 'Report', 'write_1'),
    event(7, 'output.finalized', {
      nodeId: 'output',
      artifactVersionIds: ['Report'],
      approvalId: null,
    }),
  ];
  const projection = {
    ...events.reduce(applyEvent, emptyProjection('flow_run')),
    status: 'succeeded' as const,
  };
  const loadArtifact = vi.fn();
  return {
    projection,
    definition: linearCorral(['research', 'writer']),
    session: sessionStore({ projection, events, loadArtifact }),
    loadArtifact,
  };
}
function wrap(ui: React.ReactNode) {
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </IntlProvider>,
  );
}

describe('causal execution interface', () => {
  it('keeps observed reads distinct from inputs and opens only the current result', () => {
    const { session, definition, loadArtifact } = fixture();
    const onOpenArtifact = vi.fn(),
      onSelectExecution = vi.fn();
    wrap(<RunFlowView {...{ session, definition, onOpenArtifact, onSelectExecution }} />);
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Included in model input')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Notes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Report' }));
    expect(onOpenArtifact).toHaveBeenCalledWith('Report');
    expect(loadArtifact).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'research' }));
    expect(onSelectExecution).toHaveBeenCalledWith('research_1');
  });

  it('lists only artifacts that no relationship card already shows', () => {
    const { session, definition } = fixture();
    wrap(
      <RunFlowView
        {...{ session, definition }}
        onOpenArtifact={vi.fn()}
        onSelectExecution={vi.fn()}
      />,
    );
    const list = screen.getByRole('region', { name: 'Created artifacts' });
    // Notes is the card of the research → writer relationship, so it is not repeated here.
    expect(within(list).queryByText('Notes')).toBeNull();
    expect(within(list).getByText('Report')).toBeInTheDocument();
  });

  it('shows current model activity instead of marking a running agent unrecorded', () => {
    const { session, definition, projection } = fixture();
    const execution = projection.executions.research_1;
    if (!execution) throw new Error('research fixture');
    session.setState({
      projection: {
        ...projection,
        executions: {
          ...projection.executions,
          research_1: { ...execution, status: 'active', activity: 'model' },
        },
      },
    });
    wrap(
      <RunFlowView
        session={session}
        definition={definition}
        onOpenArtifact={vi.fn()}
        onSelectExecution={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Generating response').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'research – Generating response' })).toHaveAttribute(
      'data-status',
      'working',
    );
  });

  it('names the attached artifact in a question relationship without loading its old body', () => {
    const { session, definition, projection, loadArtifact } = fixture();
    session.setState({
      projection: {
        ...projection,
        questions: {
          question: {
            questionId: 'question',
            taskId: 'question_task',
            senderExecutionId: 'research_1',
            targetExecutionId: 'write_1',
            targetNodeId: 'writer',
            targetRoleId: 'writer',
            body: 'private question',
            artifactRefs: ['Notes'],
            deadline: '2026-11-06T00:10:00.000Z',
            status: 'open',
            answer: null,
          },
        },
      },
    });
    wrap(
      <RunFlowView
        session={session}
        definition={definition}
        onOpenArtifact={vi.fn()}
        onSelectExecution={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Question sent/ }));
    expect(screen.getByText('Attached: Notes')).toBeInTheDocument();
    expect(screen.queryByText('private question')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Notes' })).toBeNull();
    expect(loadArtifact).not.toHaveBeenCalled();
  });

  it('explains exact task, approval and check evidence without opening retained bodies', () => {
    const { projection, definition } = fixture();
    projection.tasks.task_review = {
      taskId: 'task_review',
      nodeId: 'research',
      roleId: 'research',
      contract: 'text',
      status: 'completed',
      activeExecutionId: null,
      attemptCount: 1,
      submittedArtifactVersionIds: ['Notes'],
    };
    projection.approvals.approval = {
      approvalId: 'approval',
      kind: 'user_action',
      subjectVersionIds: ['Notes'],
      criteriaVersionId: null,
      status: 'approved',
    };
    wrap(
      <DecisionDetail
        projection={projection}
        definition={definition}
        onOpenArtifact={vi.fn()}
        checks={[
          {
            id: 'check_one',
            name: 'Targeted tests',
            state: 'completed',
            verdict: 'fail',
            exitCode: 1,
            timedOut: false,
          },
        ]}
        decision={{
          id: 'branch',
          nodeId: 'gate',
          iterationId: null,
          selectedPort: 'revise',
          targetNodeId: 'writer',
          targetPort: 'in',
          reasonCode: 'review_checks_failed',
          evidenceRefs: [
            { kind: 'task', id: 'task_review' },
            { kind: 'approval', id: 'approval' },
            { kind: 'check', id: 'check_one' },
          ],
          status: 'observed',
          recordedAt: null,
          configRevision: 0,
          issues: [],
        }}
      />,
    );
    expect(screen.getByText('Task · research')).toBeInTheDocument();
    expect(screen.getByText('Approval · Notes')).toBeInTheDocument();
    expect(screen.getByText('Check · Targeted tests')).toBeInTheDocument();
    expect(screen.getByText('Exit code 1')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows configured branches as unrecorded and cannot select one by keyboard or click', () => {
    const { projection, definition } = fixture();
    definition.nodes.push({
      id: 'gate',
      type: 'decision',
      label: 'Review gate',
      mode: 'rule',
      rule: 'required_tasks_submitted',
      inputBindings: [{ kind: 'run_input', name: 'brief' }],
    });
    definition.controlEdges.push({
      id: 'pass',
      source: 'gate',
      sourcePort: 'yes',
      target: 'writer',
      targetPort: 'in',
    });
    const { container } = wrap(
      <DecisionDetail
        projection={projection}
        definition={definition}
        onOpenArtifact={vi.fn()}
        decision={{
          id: 'unrecorded:gate',
          nodeId: 'gate',
          iterationId: null,
          selectedPort: null,
          targetNodeId: null,
          targetPort: null,
          reasonCode: null,
          evidenceRefs: [],
          status: 'unrecorded',
          recordedAt: null,
          configRevision: null,
          issues: [],
        }}
      />,
    );
    expect(screen.getByText('No recorded branch')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: '1' });
    expect(container.querySelector('[data-selected="true"]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
