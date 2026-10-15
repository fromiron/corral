import { Coordinator, InProcessTransport, waitForProjection } from '@corral/core';
import {
  collaborationCorral,
  FakeClock,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactViewer } from '../src/components/ArtifactViewer.tsx';
import { QuestionsPanel } from '../src/components/QuestionsPanel.tsx';
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

describe('Task Board and questions (C-025)', () => {
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

  it('[TC-OBS-001-H] goes from a question to its responder and the answer', async () => {
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
