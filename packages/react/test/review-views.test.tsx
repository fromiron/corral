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

describe('line diff', () => {
  it('aligns a large file with few changes instead of replacing it whole', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const after = before.map((line, i) => (i % 10 === 0 ? `changed ${i}` : line));
    const lines = diffLines(before.join('\n'), after.join('\n'));
    expect(lines.filter((l) => l.kind === 'same')).toHaveLength(3600);
    expect(lines.filter((l) => l.kind === 'added')).toHaveLength(400);
    expect(lines.filter((l) => l.kind === 'removed')).toHaveLength(400);
    // Order is kept: every line of the new version appears, in order.
    expect(lines.filter((l) => l.kind !== 'removed').map((l) => l.text)).toEqual(after);
  });

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

describe('approvals and reviews in Studio', () => {
  it('approves the exact version shown, and the run moves on', async () => {
    const { session, projection } = await teamAwaitingApproval();
    const approval = Object.values(projection.approvals).find((a) => a.status === 'pending');
    if (!approval) throw new Error('approval fixture');
    const open = vi.fn();
    wrap(<ApprovalPanel session={session} onOpenArtifact={open} />);
    const card = screen.getByTestId(`approval-${approval?.approvalId}`);
    for (const id of approval.subjectVersionIds) {
      const artifact = projection.artifacts[id];
      if (!artifact) throw new Error('approval artifact fixture');
      const target = within(card).getByRole('button', {
        name: `${artifact.name} v${artifact.version}`,
      });
      expect(target).toHaveAttribute('title', id);
      fireEvent.click(target);
      expect(open).toHaveBeenLastCalledWith(id);
    }
    // The criteria it is judged against are on the card, from the run's snapshot.
    await waitFor(() =>
      expect(card).toHaveTextContent(researchTeam.input.criteria[0] ?? 'missing'),
    );
    // UX-11: the approve button names what approving this step does.
    fireEvent.click(
      within(card).getByRole('button', {
        name: /^(Continue with this version|Confirm as final result)$/,
      }),
    );
    await until(session, (p) => p.approvals[approval?.approvalId ?? '']?.status === 'approved');
    await until(session, (p) => Object.values(p.approvals).some((a) => a.kind === 'final_output'));
  });

  it('lets the person pick a route when the router could not, and the run follows it', async () => {
    const base = CorralDefinition.parse(researchTeam);
    const agent = (id: string, source?: string) => ({
      id,
      type: 'agent' as const,
      label: id,
      roleId: 'writer',
      invocation: 'scheduled' as const,
      inputBindings: source
        ? [{ kind: 'task_output' as const, name: 'draft', sourceNodeId: source }]
        : [{ kind: 'run_input' as const, name: 'brief' }],
      outputName: 'draft',
    });
    const definition = CorralDefinition.parse({
      ...base,
      entryNodeId: 'w',
      capabilityLinks: [],
      nodes: [
        agent('w'),
        {
          id: 'router',
          type: 'decision',
          label: 'router',
          mode: 'router',
          routes: [
            { id: 'fix', label: 'Fix it' },
            { id: 'ship', label: 'Ship it' },
          ],
          inputBindings: [{ kind: 'task_output', name: 'draft', sourceNodeId: 'w' }],
        },
        agent('fix', 'w'),
        agent('ship', 'w'),
        {
          id: 'output',
          type: 'output',
          label: 'output',
          inputBindings: ['fix', 'ship'].map((id) => ({
            kind: 'task_output' as const,
            name: id,
            sourceNodeId: id,
            optional: true,
          })),
          requireApproval: false,
        },
      ],
      controlEdges: [
        { id: 'e1', source: 'w', sourcePort: 'out', target: 'router', targetPort: 'in' },
        { id: 'e2', source: 'router', sourcePort: 'fix', target: 'fix', targetPort: 'in' },
        { id: 'e3', source: 'router', sourcePort: 'ship', target: 'ship', targetPort: 'in' },
        { id: 'e4', source: 'fix', sourcePort: 'out', target: 'output', targetPort: 'in' },
        { id: 'e5', source: 'ship', sourcePort: 'out', target: 'output', targetPort: 'in' },
      ],
    });
    const clock = new FakeClock();
    const session = createRunSession(
      new InProcessTransport(
        new Coordinator({
          clock,
          ids: new SequentialIdFactory(),
          timers: clock,
          // The chooser answers with prose, not a route id.
          agents: new ScriptedAgentAdapter({ turns: 1, appendNotes: false }),
        }),
      ),
    );
    await session.getState().start(definition);
    const p = await until(session, (x) => x.status === 'awaiting_user');
    const approval = Object.values(p.approvals).find((a) => a.status === 'pending');
    expect(approval?.kind).toBe('route');
    wrap(<ApprovalPanel session={session} onOpenArtifact={() => {}} />);
    const card = screen.getByTestId(`approval-${approval?.approvalId}`);
    expect(within(card).getByText('Choose a route')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Stop here' })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Ship it' }));
    const done = await until(session, (x) => x.status === 'succeeded');
    expect(done.approvals[approval?.approvalId ?? '']?.routeId).toBe('ship');
    expect(done.nodeExecutions.ship).toHaveLength(1);
    expect(done.nodeExecutions.fix).toBeUndefined();
  });

  it('keeps recorded review evidence without opening older artifact bodies', async () => {
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
    // The observed input remains as metadata; its older body is not a navigation target.
    expect(viewer).toHaveTextContent(review1?.reviewVersionId ?? 'missing');
    expect(within(viewer).queryByRole('button', { name: review1?.reviewVersionId })).toBeNull();
    expect(within(viewer).queryByRole('button', { name: /Compare with|New run from/ })).toBeNull();
    expect(viewer.querySelector('[data-diff]')).toBeNull();

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

describe('Reins artifact input paths', () => {
  it('does not link a later accepted instruction to an older request result', async () => {
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
            origin: 'user',
            delivery: 'next_request',
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

  it('separates request directives from directives carried through an input artifact', async () => {
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
            origin: 'user',
            delivery: 'next_request',
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
            origin: 'user',
            delivery: 'next_request',
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
