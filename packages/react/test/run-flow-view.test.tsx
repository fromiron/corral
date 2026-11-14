import { type EventOf, RunEvent } from '@corral/contracts';
import { applyEvent, emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { DecisionDetail } from '../src/components/RunFlowDecisions.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };

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
  return { projection, definition: linearCorral(['research', 'writer']) };
}
function wrap(ui: React.ReactNode) {
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </IntlProvider>,
  );
}

describe('a recorded decision', () => {
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
