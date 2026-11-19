import { Coordinator, InProcessTransport, waitForProjection } from '@corral/core';
import {
  collaborationCorral,
  FakeClock,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactViewer } from '../src/components/ArtifactViewer.tsx';
import { ExecutionTranscript } from '../src/components/ExecutionTranscript.tsx';
import { QuestionsPanel } from '../src/components/QuestionsPanel.tsx';
import { RunView } from '../src/components/RunView.tsx';
import { TaskBoard } from '../src/components/TaskBoard.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { createRunSession } from '../src/run/session.ts';

/** A finished run of the collaboration fixture, followed by a real session. */
async function finishedRun() {
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
  await session.getState().start(collaborationCorral());
  const runId = session.getState().runId ?? '';
  await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
  for (let i = 0; i < 50 && session.getState().projection?.status !== 'succeeded'; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return session;
}

const wrap = (ui: React.ReactNode) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </IntlProvider>,
  );

describe('Task Board and questions', () => {
  it('links the reviewed version from the requesting worker’s transcript', async () => {
    const session = await finishedRun();
    const { projection, events } = session.getState();
    const question = Object.values(projection?.questions ?? {})[0];
    const id = projection?.output?.artifactVersionIds[0];
    const artifact = id && projection?.artifacts[id];
    if (!projection || !question || !id || !artifact) throw new Error('review target fixture');
    session.setState({
      projection: {
        ...projection,
        questions: {
          [question.questionId]: { ...question, sharedOutrider: true, reviewArtifactVersionId: id },
        },
      },
      events: events.map((e) =>
        e.type === 'message.question_created' && e.payload.questionId === question.questionId
          ? { ...e, payload: { ...e.payload, sharedOutrider: true, reviewArtifactVersionId: id } }
          : e,
      ),
    });
    const open = vi.fn();
    wrap(
      <ExecutionTranscript
        session={session}
        executionId={question.senderExecutionId}
        onOpenArtifact={open}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: `Requested a review of ${artifact.name} v${artifact.version}`,
      }),
    );
    expect(open).toHaveBeenCalledWith(id);
    expect(screen.getByRole('log')).toHaveTextContent(
      question.answer?.body.split('\n')[0] ?? 'missing opinion',
    );
    session.getState().dispose();
  });

  it('keeps the requested artifact review on V1 when the test run opens the writer’s submitted V2', async () => {
    const session = await finishedRun();
    const p = session.getState().projection;
    const question = Object.values(p?.questions ?? {})[0];
    const versionId = p?.output?.artifactVersionIds[0];
    const result = versionId && p?.artifacts[versionId];
    if (!p || !question?.answer || !result || !p.output) throw new Error('finished draft fixture');
    const output = p.output;
    const ordinary = {
      ...question,
      sharedOutrider: true as const,
      artifactRefs: ['draft_v1'],
      body: 'Which style guide should I use?',
    };
    const review = {
      ...ordinary,
      questionId: 'review_request',
      reviewArtifactVersionId: 'draft_v1',
      body: 'Check the evidence in V1.',
      answer: {
        ...question.answer,
        body: 'Cite the source on page four.',
        evidenceRefs: ['draft_v1'],
      },
    };
    const first = { ...result, artifactVersionId: 'draft_v1', version: 1 };
    const second = {
      ...result,
      artifactVersionId: 'draft_v2',
      parentVersionId: 'draft_v1',
      version: 2,
    };
    session.setState({
      projection: {
        ...p,
        status: 'running',
        questions: { [ordinary.questionId]: ordinary, review_request: review },
        artifacts: { ...p.artifacts, draft_v1: first },
        output: null,
      },
    });
    const open = vi.fn();
    wrap(<RunView session={session} onSteer={vi.fn()} onOpenArtifact={open} />);
    const row = await screen.findByTestId('question-review_request');
    expect(row).toHaveTextContent('Writer');
    expect(row).toHaveTextContent('Outrider');
    expect(row).toHaveTextContent('Cite the source on page four.');
    const reviewed = `Requested a review of ${first.name} v1`;
    fireEvent.click(within(row).getByRole('button', { name: reviewed }));
    expect(open).toHaveBeenLastCalledWith('draft_v1');
    expect(screen.getByTestId(`question-${ordinary.questionId}`)).not.toHaveTextContent(
      'Requested a review',
    );
    act(() =>
      session.setState({
        projection: {
          ...p,
          questions: { [ordinary.questionId]: ordinary, review_request: review },
          artifacts: {
            ...p.artifacts,
            draft_v1: { ...first, bodyAvailable: false },
            draft_v2: second,
          },
          output: { ...output, artifactVersionIds: ['draft_v2'] },
        },
      }),
    );
    expect(row).toHaveTextContent(reviewed);
    expect(row).toHaveTextContent('The reviewed version’s content is no longer available.');
    expect(within(row).queryByRole('button', { name: /draft_v1|v1/i })).toBeNull();
    expect(row).toHaveTextContent('Cite the source on page four.');
    expect(screen.getByText('Submitted result · Writer')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: `${second.name} v2` }));
    expect(open).toHaveBeenLastCalledWith('draft_v2');
    session.getState().dispose();
  });

  it('lists every task with its owner, parent and submitted versions', async () => {
    const session = await finishedRun();
    const onOpen = vi.fn();
    wrap(<TaskBoard session={session} onOpenArtifact={onOpen} />);
    const p = session.getState().projection;
    const helpers = (p?.nodeExecutions.helper ?? []).map((id) => p?.executions[id]);
    expect(helpers).toHaveLength(2);
    for (const helper of helpers) {
      const row = screen.getByTestId(`task-${helper?.taskId}`);
      expect(row).toHaveTextContent('Research Helper');
      expect(row).toHaveTextContent('Completed');
      // The parent is named and linked, so the call tree is one click away.
      const parent = within(row).getByRole('link', { name: /Research/ });
      expect(parent.getAttribute('href')).toBe(`#execution-${helper?.parentExecutionId}`);
      const version = p?.tasks[helper?.taskId ?? '']?.submittedArtifactVersionIds[0];
      fireEvent.click(within(row).getByRole('button', { name: version }));
      expect(onOpen).toHaveBeenLastCalledWith(version);
    }
  });

  it('goes from a question to its responder and the answer', async () => {
    const session = await finishedRun();
    wrap(<QuestionsPanel session={session} onOpenArtifact={vi.fn()} />);
    const p = session.getState().projection;
    const [question] = Object.values(p?.questions ?? {});
    const item = screen.getByTestId(`question-${question?.questionId}`);
    expect(item).toHaveTextContent('Writer');
    expect(item).toHaveTextContent('Source Responder');
    expect(item).toHaveTextContent('Answered');
    expect(item).toHaveTextContent(question?.body ?? 'missing');
    const responder = within(item).getByRole('link', { name: /Source Responder/ });
    expect(responder.getAttribute('href')).toBe(
      `#execution-${question?.answer?.responderExecutionId}`,
    );
    expect(item).toHaveTextContent(question?.answer?.body.split('\n')[0] ?? 'missing');
  });

  it('shows an artifact version as safe Markdown, with where it came from', async () => {
    const session = await finishedRun();
    const p = session.getState().projection;
    const versionId = p?.output?.artifactVersionIds[0] ?? '';
    await session.getState().loadArtifact(versionId);
    wrap(<ArtifactViewer session={session} versionId={versionId} onClose={vi.fn()} />);
    const viewer = screen.getByTestId('artifact-viewer');
    expect(viewer).toHaveTextContent('draft');
    expect(viewer).toHaveTextContent('Version 1');
    expect(viewer).toHaveTextContent('Writer');
    expect(viewer.querySelector('script')).toBeNull();
    expect(viewer).toHaveTextContent(
      session.getState().artifactTexts[versionId]?.split('\n')[0] ?? 'x',
    );
  });
});

it('shows that the logical question timeout stops during a user pause', async () => {
  const session = await finishedRun();
  const p = session.getState().projection;
  const question = Object.values(p?.questions ?? {})[0];
  if (!p || !question) throw new Error('question fixture');
  session.setState({
    projection: {
      ...p,
      status: 'paused',
      questions: {
        ...p.questions,
        [question.questionId]: { ...question, status: 'open', answer: null },
      },
    },
  });
  wrap(<QuestionsPanel session={session} onOpenArtifact={vi.fn()} />);
  const row = screen.getByTestId(`question-${question.questionId}`);
  expect(row).toHaveTextContent('The question timeout is paused.');
  expect(row).not.toHaveTextContent(`Waiting for a reply until ${question.deadline}`);
});

it('shows a shared consultation waiting and then answered without relabelling manual questions', async () => {
  const session = await finishedRun();
  const projection = session.getState().projection;
  const question = Object.values(projection?.questions ?? {})[0];
  if (!projection || !question?.answer) throw new Error('answered question fixture');
  const shared = { ...question, sharedOutrider: true as const };
  const show = (waiting: boolean) =>
    session.setState({
      projection: {
        ...projection,
        questions: {
          ...projection.questions,
          [question.questionId]: waiting ? { ...shared, status: 'open', answer: null } : shared,
        },
      },
    });
  show(true);
  wrap(<QuestionsPanel session={session} onOpenArtifact={vi.fn()} />);
  const item = screen.getByTestId(`question-${question.questionId}`);
  const row = within(item);
  expect(row.getByText('Waiting for an answer', { exact: true })).toBeVisible();
  act(() => show(false));
  expect(row.getByText('Answer received', { exact: true })).toBeVisible();
  expect(item).toHaveTextContent(question.answer.body.replace(/\s+/g, ' ').trim());
  act(() => session.setState({ projection }));
  expect(row.getByText('Answered', { exact: true })).toBeVisible();
});
