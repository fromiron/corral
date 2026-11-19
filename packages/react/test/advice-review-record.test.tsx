import { type CorralDefinition, RunEvent } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { assert, expect, it, vi } from 'vitest';
import { RunView } from '../src/components/RunView.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import type { RunSessionStore } from '../src/run/session.ts';
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';
import { loopFlowFixture } from '../src/stories/loopFlowFixture.ts';

const shared = {
  modelProfile: 'critic',
  principles: 'Check facts.',
  targets: { kind: 'all' as const },
};
function show(
  session: RunSessionStore,
  locale: 'en' | 'ko' = 'en',
  readTeam?: (runId: string) => Promise<CorralDefinition | null>,
) {
  const onOpenArtifact = vi.fn();
  render(
    <IntlProvider locale={locale} messages={locale === 'en' ? en : ko} timeZone="UTC">
      <RunView
        session={session}
        onSteer={vi.fn()}
        onOpenArtifact={onOpenArtifact}
        readTeam={readTeam}
      />
    </IntlProvider>,
  );
  return onOpenArtifact;
}
const record = () => within(screen.getByRole('region', { name: 'Advice and review' }));

it('omits the record when neither a shared Outrider nor a required review was configured', () => {
  show(sessionStore({ definition: linearCorral(['writer']), projection: projectionWith({}) }));
  expect(screen.queryByRole('heading', { name: 'Advice and review' })).toBeNull();
});

it('never says nobody asked from the execution copy alone, even if it contains an Outrider setting', () => {
  show(
    sessionStore({
      runId: 'run_story',
      definition: { ...linearCorral(['writer']), sharedOutrider: shared },
      projection: projectionWith({}),
    }),
  );
  expect(screen.queryByText(/nobody asked/i)).toBeNull();
});

it.each([true, false])(
  'reads the pinned team after opening a run, even with a conflicting start argument (%s)',
  async (reloaded) => {
    const team = linearCorral(['writer']);
    const read = vi.fn(async () => ({ ...team, sharedOutrider: shared }));
    show(
      sessionStore({
        runId: 'run_story',
        definition: team,
        startDefinition: reloaded ? null : team,
        projection: projectionWith({}),
      }),
      'en',
      read,
    );
    expect(await screen.findByText(/nobody asked/i)).toBeVisible();
    expect(read).toHaveBeenCalledExactlyOnceWith('run_story');
  },
);

it('uses the start argument if the host cannot read the pinned revision', async () => {
  const team = linearCorral(['writer']);
  show(
    sessionStore({
      runId: 'run_story',
      definition: team,
      startDefinition: { ...team, sharedOutrider: shared },
      projection: projectionWith({}),
    }),
    'en',
    async () => null,
  );
  expect(await screen.findByText(/nobody asked/i)).toBeVisible();
});

it('says nobody asked in Korean, without offering an empty questions list', () => {
  show(
    sessionStore({
      runId: 'run_story',
      startDefinition: { ...linearCorral(['writer']), sharedOutrider: shared },
      projection: projectionWith({}),
    }),
    'ko',
  );
  const section = within(screen.getByRole('region', { name: '자문과 검토' }));
  expect(section.getByText('요청형 자문 0회 · 아무도 묻지 않았습니다')).toBeVisible();
  expect(section.queryByRole('button')).toBeNull();
});

it('links actual shared questions to the questions list and reports answered and cancelled separately', () => {
  const question: RunProjection['questions'][string] = {
    questionId: 'asked',
    taskId: 't',
    senderExecutionId: 'w',
    targetNodeId: 'outrider',
    targetRoleId: 'responder',
    body: 'Check this?',
    artifactRefs: [],
    deadline: '2026-11-10T00:00:00Z',
    sharedOutrider: true,
    status: 'answered',
    answer: { responderExecutionId: 'r', body: 'Yes.', evidenceRefs: [] },
  };
  show(
    sessionStore({
      definition: linearCorral(['writer']),
      projection: projectionWith({
        questions: {
          asked: question,
          stopped: { ...question, questionId: 'stopped', status: 'cancelled', answer: null },
        },
      }),
    }),
  );
  const evidence = record().getByRole('link', { name: /2 requests.*1 answered.*1 cancelled/i });
  const target = document.getElementById((evidence as HTMLAnchorElement).hash.slice(1));
  expect(target).toContainElement(screen.getByRole('heading', { name: 'Questions' }));
});

it('uses one polite region and leaves it untouched for events that change none of its facts', () => {
  const session = sessionStore({
    runId: 'run_story',
    startDefinition: { ...linearCorral(['writer']), sharedOutrider: shared },
    projection: projectionWith({}),
  });
  show(session);
  const list = record().getByRole('list');
  expect(list).toHaveAttribute('aria-live', 'polite');
  expect(list).toHaveAttribute('aria-atomic', 'true');
  const changes = new MutationObserver(() => {});
  changes.observe(list, { childList: true, subtree: true, characterData: true });
  act(() => session.setState({ projection: projectionWith({ lastSeq: 1 }) }));
  expect(changes.takeRecords()).toHaveLength(0);
  changes.disconnect();
});

function reviewRun() {
  const { definition, projection, session } = loopFlowFixture(2);
  const output = definition.nodes.find((n) => n.type === 'output');
  assert(output);
  output.requiredReviews = [
    {
      bindingName: 'final',
      sourceNodeId: 'writer',
      reviewerNodeId: 'critic',
      loopNodeId: 'review_loop',
      decisionNodeId: 'gate',
    },
  ];
  const writer = definition.nodes.find((n) => n.id === 'writer');
  assert(writer);
  writer.label = 'Writer';
  projection.currentCriteriaVersionId = 'criteria';
  for (const no of [1, 2]) {
    const branch = projection.workflowBranches?.[`branch_${no}`];
    assert(branch);
    const verdict = no === 2 ? 'pass' : 'revise';
    branch.selectedPort = verdict;
    branch.evidenceRefs = [{ kind: 'review', id: `verdict_${no}` }];
    projection.reviews[`verdict_${no}`] = {
      reviewVersionId: `verdict_${no}`,
      targetVersionId: `draft_${no}`,
      criteriaVersionId: 'criteria',
      verdict,
      stale: false,
      newCriteriaVersionId: null,
      issues: [],
    };
  }
  return { projection, session };
}

it('opens the passing second round and the exact V2 submitted by the writer', () => {
  const { session } = reviewRun();
  const open = show(session);
  const round = record().getByRole('button', { name: /final.*passed in round 2/i });
  const fold = screen.getAllByRole('button', { name: /Fold the executions under/i })[0];
  assert(fold);
  fireEvent.click(fold);
  fireEvent.click(round);
  const picker = screen.getByRole('combobox', { name: 'Round for Review' });
  expect(picker).toHaveFocus();
  expect(picker).toHaveTextContent('Round 2');
  fireEvent.click(record().getByRole('button', { name: /Draft round 2 v2.*submitted by Writer/i }));
  expect(open).toHaveBeenCalledExactlyOnceWith('draft_2');
});

it('reports the current round, then cancellation without claiming a pass or final submission', () => {
  const { session, projection } = reviewRun();
  projection.output = null;
  projection.status = 'running';
  assert(projection.workflowBranches);
  delete projection.workflowBranches.branch_2;
  delete projection.reviews.verdict_2;
  assert(projection.iterations.round_2);
  projection.iterations.round_2.outcome = null;
  show(session);
  const section = record();
  expect(section.getByRole('button', { name: /round 2 in progress/i })).toBeVisible();
  act(() => session.setState({ projection: { ...projection, status: 'cancelled' } }));
  expect(section.getByText(/cancelled · no final submission/i)).toBeVisible();
  expect(section.queryByText(/passed|submitted by/i)).toBeNull();
});

it('says the limit was exhausted with no final submission in Korean', () => {
  const { session, projection } = reviewRun();
  projection.output = null;
  projection.status = 'failed';
  projection.statusReason = 'loop_exhausted: review_loop cap_reached';
  assert(
    projection.iterations.round_2 &&
      projection.workflowBranches?.branch_2 &&
      projection.reviews.verdict_2,
  );
  projection.iterations.round_2.outcome = 'cap_reached';
  projection.workflowBranches.branch_2.selectedPort = 'revise';
  projection.reviews.verdict_2.verdict = 'revise';
  show(session, 'ko');
  expect(
    within(screen.getByRole('region', { name: '자문과 검토' })).getByText(
      /통과하지 못함 · 최종 제출 없음/,
    ),
  ).toBeVisible();
});

it('keeps a late observer response separate from delivered advice and reveals the event', () => {
  const { definition, projection } = loopFlowFixture(1);
  definition.sharedOutrider = {
    ...shared,
    observation: { targets: { kind: 'all' }, review: { interval: 1, maxRequestsPerReview: 1 } },
  };
  assert(projection.executions.writer_1);
  projection.executions.observer = {
    ...projection.executions.writer_1,
    executionId: 'observer',
    nodeId: 'observer',
    advisor: true,
  };
  const event = RunEvent.parse({
    schemaVersion: '0.1',
    runId: projection.runId,
    runSeq: 8,
    eventId: 'late_8',
    actor: { kind: 'runtime', id: 'runtime' },
    recordedAt: '2026-11-10T00:00:00Z',
    causedByEventIds: [],
    executionId: 'observer',
    type: 'observation.late',
    payload: {
      originalRef: 'call_late',
      originalEventType: 'model.finished',
      whyIgnored: 'the request or scope has ended',
    },
  });
  projection.lastSeq = event.runSeq;
  show(
    sessionStore({
      runId: projection.runId,
      startDefinition: definition,
      definition,
      projection,
      events: [event],
    }),
  );
  expect(record().getByText(/0 delivered/i)).toBeVisible();
  fireEvent.click(record().getByText(/1 arrived late.*not applied/i));
  expect(record().getByText(/model\.finished/)).toBeVisible();
});
