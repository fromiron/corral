import { CorralDefinition } from '@corral/contracts';
import { Coordinator, InProcessTransport, type RunProjection } from '@corral/core';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { diffLines } from '../src/artifacts/diff.ts';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import { ArtifactViewer } from '../src/components/ArtifactViewer.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { createRunSession, type RunSessionStore } from '../src/run/session.ts';

async function until(session: RunSessionStore, check: (p: RunProjection) => boolean) {
  for (let i = 0; i < 400; i++) {
    const p = session.getState().projection;
    if (p && check(p)) return p;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not reached');
}

async function teamAwaitingApproval() {
  const clock = new FakeClock();
  const transport = new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    }),
  );
  const session = createRunSession(transport);
  await session.getState().start(CorralDefinition.parse(researchTeam));
  const p = await until(session, (x) => x.status === 'awaiting_user');
  return { session, projection: p };
}

const wrap = (ui: React.ReactNode) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </IntlProvider>,
  );

describe('line diff (C-030)', () => {
  it('keeps shared lines and marks what was removed and added', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });
});

describe('approvals and reviews in Studio (C-029, C-030)', () => {
  it('[TC-ART-004-H] approves the exact version shown, and the run moves on', async () => {
    const { session, projection } = await teamAwaitingApproval();
    const approval = Object.values(projection.approvals).find((a) => a.status === 'pending');
    wrap(<ApprovalPanel session={session} onOpenArtifact={vi.fn()} />);
    const card = screen.getByTestId(`approval-${approval?.approvalId}`);
    expect(card).toHaveTextContent(approval?.subjectVersionIds[0] ?? 'missing');
    // The criteria it is judged against are on the card, from the run's snapshot.
    await waitFor(() =>
      expect(card).toHaveTextContent(researchTeam.input.criteria[0] ?? 'missing'),
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await until(session, (p) => p.approvals[approval?.approvalId ?? '']?.status === 'approved');
    await until(session, (p) => Object.values(p.approvals).some((a) => a.kind === 'final_output'));
  });

  it('[TC-OBS-001-H] follows draft@1 → review@1 → draft@2, with the diff and the review verdict', async () => {
    const { session, projection } = await teamAwaitingApproval();
    const drafts = Object.values(projection.artifacts).filter((a) => a.name === 'draft');
    const [draft1, draft2] = drafts.sort((a, b) => a.version - b.version);
    const review1 = Object.values(projection.reviews)[0];
    wrap(
      <ArtifactViewer
        session={session}
        versionId={draft2?.artifactVersionId ?? ''}
        onClose={vi.fn()}
      />,
    );
    const viewer = await screen.findByTestId('artifact-viewer');
    expect(viewer).toHaveTextContent('Version 2');
    // It revises draft@1 and was written from review@1.
    expect(within(viewer).getByRole('button', { name: draft1?.artifactVersionId })).toBeTruthy();
    expect(within(viewer).getByRole('button', { name: review1?.reviewVersionId })).toBeTruthy();
    fireEvent.click(within(viewer).getByRole('button', { name: /Compare with/ }));
    await waitFor(() =>
      expect(viewer.querySelector('[data-diff="removed"], [data-diff="added"]')).not.toBeNull(),
    );

    // A review renders as its verdict and issues, about the version it names.
    const reviewView = wrap(
      <ArtifactViewer
        session={session}
        versionId={review1?.reviewVersionId ?? ''}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(reviewView.container).toHaveTextContent('Revise'));
    expect(reviewView.container).toHaveTextContent('Cite a primary source');
    expect(reviewView.container).toHaveTextContent(draft1?.artifactVersionId ?? 'missing');
  });
});

describe('Reins artifact input paths (C-036)', () => {
  it('[TC-RNS-010-N] does not link a later accepted instruction to an older request result', async () => {
    const { session, projection } = await teamAwaitingApproval();
    const artifact = Object.values(projection.artifacts).find((a) => a.modelCallId);
    if (!artifact) throw new Error('artifact fixture');
    const call = projection.modelCalls[artifact.modelCallId ?? ''];
    if (!call) throw new Error('call fixture');
    session.setState({
      projection: {
        ...projection,
        directives: {
          ...projection.directives,
          dir_late: {
            directiveId: 'dir_late',
            targetExecutionId: artifact.authorExecutionId,
            text: 'Late instruction must stay out',
            status: 'queued',
            commandId: 'cmd_late',
            acceptedSeq: projection.lastSeq,
            contextSnapshotId: null,
            modelCallId: null,
            reason: null,
          },
        },
      },
    });
    wrap(
      <ArtifactViewer session={session} versionId={artifact.artifactVersionId} onClose={vi.fn()} />,
    );
    const paths = screen.getByTestId('artifact-lineage');
    expect(paths).toHaveTextContent(call.modelCallId);
    expect(paths).toHaveTextContent(call.contextSnapshotId);
    expect(paths).not.toHaveTextContent('Late instruction must stay out');
    expect(
      within(paths).getByText('Instructions in the producing request').nextSibling,
    ).toHaveTextContent('None recorded');
  });

  it('[TC-RNS-010-H] separates request directives from directives carried through an input artifact', async () => {
    const { session, projection } = await teamAwaitingApproval();
    const drafts = Object.values(projection.artifacts)
      .filter((a) => a.name === 'draft')
      .sort((a, b) => a.version - b.version);
    const [first, second] = drafts;
    if (!first?.modelCallId || !second?.modelCallId) throw new Error('draft fixtures');
    const firstCall = projection.modelCalls[first.modelCallId];
    const secondCall = projection.modelCalls[second.modelCallId];
    if (!firstCall || !secondCall) throw new Error('call fixtures');
    session.setState({
      projection: {
        ...projection,
        directives: {
          ...projection.directives,
          dir_indirect: {
            directiveId: 'dir_indirect',
            targetExecutionId: first.authorExecutionId,
            text: 'Earlier instruction',
            status: 'delivered',
            commandId: 'cmd_indirect',
            acceptedSeq: 1,
            modelCallId: firstCall.modelCallId,
            contextSnapshotId: firstCall.contextSnapshotId,
            reason: null,
          },
          dir_direct: {
            directiveId: 'dir_direct',
            targetExecutionId: second.authorExecutionId,
            text: 'Current instruction',
            status: 'delivered',
            commandId: 'cmd_direct',
            acceptedSeq: 2,
            modelCallId: secondCall.modelCallId,
            contextSnapshotId: secondCall.contextSnapshotId,
            reason: null,
          },
        },
        modelCalls: {
          ...projection.modelCalls,
          [firstCall.modelCallId]: { ...firstCall, directiveIds: ['dir_indirect'] },
          [secondCall.modelCallId]: { ...secondCall, directiveIds: ['dir_direct'] },
        },
      },
    });
    wrap(
      <ArtifactViewer session={session} versionId={second.artifactVersionId} onClose={vi.fn()} />,
    );
    const paths = screen.getByTestId('artifact-lineage');
    expect(
      within(paths).getByText('Instructions in the producing request').nextSibling,
    ).toHaveTextContent('dir_direct');
    expect(
      within(paths).getByText('Instructions through input versions').nextSibling,
    ).toHaveTextContent('dir_indirect');
    expect(
      within(paths).getByText('Instructions in the producing request').nextSibling,
    ).not.toHaveTextContent('dir_indirect');
  });
});

it('opens the recorded criteria version as safe text and keeps Close available', async () => {
  const { session, projection } = await teamAwaitingApproval();
  const artifact = Object.values(projection.artifacts).find(
    (a) => a.criteriaVersionId && a.modelCallId,
  );
  if (!artifact?.criteriaVersionId) throw new Error('criteria fixture');
  const onClose = vi.fn();
  wrap(
    <ArtifactViewer session={session} versionId={artifact.artifactVersionId} onClose={onClose} />,
  );
  fireEvent.click(screen.getByRole('button', { name: artifact.criteriaVersionId }));
  const viewer = await screen.findByTestId('artifact-viewer');
  await waitFor(() =>
    expect(viewer).toHaveTextContent(researchTeam.input.criteria[0] ?? 'missing'),
  );
  expect(viewer).toHaveTextContent('Recorded reference');
  fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('opens a durable tool-result input reference as literal text', async () => {
  const { session, projection } = await teamAwaitingApproval();
  const artifact = Object.values(projection.artifacts).find((a) => a.modelCallId);
  if (!artifact) throw new Error('artifact fixture');
  session.setState({
    projection: {
      ...projection,
      artifacts: {
        ...projection.artifacts,
        [artifact.artifactVersionId]: { ...artifact, inputArtifactVersionIds: ['source_1'] },
      },
      toolCalls: {
        ...projection.toolCalls,
        tool_source: {
          toolCallId: 'tool_source',
          executionId: artifact.authorExecutionId,
          name: 'read_url',
          status: 'requested',
          reason: null,
          resultRef: 'source_1',
        },
      },
    },
    artifactTexts: {
      ...session.getState().artifactTexts,
      source_1: '<script>bad()</script> Verified document source',
    },
  });
  wrap(
    <ArtifactViewer session={session} versionId={artifact.artifactVersionId} onClose={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'source_1' }));
  const viewer = await screen.findByTestId('artifact-viewer');
  expect(viewer).toHaveTextContent('<script>bad()</script> Verified document source');
  expect(viewer.querySelector('script')).toBeNull();
});
