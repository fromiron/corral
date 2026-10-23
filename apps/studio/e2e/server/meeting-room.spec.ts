import type { MeetingHandoffReceipt, MeetingView } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { Gate } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { requestBox } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

// CR-049: only model replies are simulated. Creation, rounds, decisions and handoffs
// use the production Studio, HTTP API, persisted session and Coordinator.
test.use({
  agentReply: {
    reply: (_turn, input) => {
      if (input.role.name !== 'Secretary')
        return input.role.name === 'Builder'
          ? 'Keep the API, but measure latency before release.'
          : 'Keep one service and preserve the API.';
      const brief = input.inputs.map((item) => item.text).join('\n');
      const roundId = /Round 1 \[roundId=([^\]]+)\]/.exec(brief)?.[1];
      if (!roundId) throw new Error('Secretary needs the actual prior round reference.');
      return JSON.stringify({
        issues: ['Whether to split the service'],
        claims: [{ roundId, participantId: 'p1', text: 'Keep one service.' }],
        agreements: [
          {
            text: 'Preserve the API.',
            supporters: [
              { roundId, participantId: 'p1' },
              { roundId, participantId: 'p2' },
            ],
          },
        ],
        remainingDissent: [
          { roundId, participantId: 'p2', text: 'Measure latency before release.' },
        ],
        unverifiedFacts: ['Production latency has not been measured.'],
        candidates: [
          {
            candidateId: 'measure',
            content: {
              goal: 'Validate the existing service',
              scope: ['API compatibility'],
              excludedScope: ['UI redesign'],
              acceptanceCriteria: ['Existing clients still work'],
              remainingDissent: ['Builder requires latency measurements before release.'],
              evidence: ['The participants discussed the existing API.'],
              risks: ['Latency is unknown'],
              actions: ['Measure latency', 'Publish the result'],
              rejectedAlternatives: ['Split services immediately'],
            },
          },
        ],
      });
    },
  },
});

async function createMeeting(page: Page, corral: Harness) {
  await page.goto(`${corral.server.url}/projects/default`);
  await page.getByRole('button', { name: 'New meeting', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a meeting' });
  await dialog.getByLabel('Meeting name', { exact: true }).fill('Release discussion');
  await dialog.getByRole('button', { name: 'Remove participant 3', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Participant 1 model', exact: true }).click();
  await page.getByRole('option', { name: 'model-b', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create meeting', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  await expect(page.getByRole('textbox', { name: 'Meeting message' })).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
}

async function meeting(page: Page, id: string): Promise<MeetingView> {
  const response = await page.request.get(
    new URL(`/api/v1/sessions/${id}/meeting`, page.url()).href,
  );
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function session(page: Page, id: string): Promise<WorkSession> {
  const response = await page.request.get(new URL(`/api/v1/sessions/${id}`, page.url()).href);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Meeting message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function finishRound(page: Page, id: string, index: number) {
  await expect
    .poll(async () =>
      (await meeting(page, id)).rounds[index]?.answers.every(
        (answer) => answer.status === 'answered',
      ),
    )
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Stop round', exact: true })).toHaveCount(0);
}

async function adoptDecision(page: Page, id: string) {
  await send(page, 'Should we split the service?');
  await finishRound(page, id, 0);
  await page.getByRole('button', { name: 'Summarise meeting', exact: true }).click();
  await finishRound(page, id, 1);
  await expect
    .poll(async () => (await meeting(page, id)).minutes?.[0]?.document?.candidates.length)
    .toBe(1);
  await page.getByText('Minutes, decisions and handoffs', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hand off to work', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review and adopt', exact: true }).click();
  await page.locator('textarea[name="goal"]').fill('Measure before releasing');
  await page.locator('textarea[name="actions"]').fill('Measure latency');
  await page.getByRole('button', { name: 'Adopt decision', exact: true }).click();
  await expect.poll(async () => (await meeting(page, id)).decisions?.length).toBe(1);
}

test('[TC-MEET-001-H] role and secretary selection survive reopening without more calls', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const id = await createMeeting(page, corral);
  expect((await meeting(page, id)).config.participants[0]?.modelProfile).toBe('model-b');
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  await send(page, 'Should we split the service?');
  await finishRound(page, id, 0);
  const all = page.getByRole('region', { name: 'Should we split the service?', exact: true });
  await expect(all.getByRole('article')).toHaveCount(2);
  await expect(all.getByRole('article').nth(0)).toHaveAttribute('aria-label', 'Architect');
  await expect(all.getByRole('article').nth(1)).toHaveAttribute('aria-label', 'Builder');
  await page.screenshot({ path: test.info().outputPath('meeting-room-desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await send(page, '@Builder clarify the measurement');
  await finishRound(page, id, 1);
  const mentioned = page.getByRole('region', {
    name: '@Builder clarify the measurement',
    exact: true,
  });
  await expect(mentioned.getByRole('article')).toHaveCount(1);
  await expect(mentioned.getByRole('article')).toHaveAttribute('aria-label', 'Builder');
  await page.screenshot({ path: test.info().outputPath('meeting-room-narrow.png') });
  const secretary = page.getByRole('button', { name: '@Secretary', exact: true });
  await secretary.focus();
  await page.keyboard.press('Space');
  await expect(secretary).toHaveAttribute('aria-pressed', 'true');
  await send(page, 'Record the remaining disagreement');
  await finishRound(page, id, 2);
  await expect(
    page
      .getByRole('region', { name: 'Record the remaining disagreement', exact: true })
      .getByRole('article'),
  ).toHaveAttribute('aria-label', 'Secretary');
  await page.screenshot({ path: test.info().outputPath('meeting-room-minutes.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const runs = corral.server.coordinator.listRuns().map((run) => run.runId);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Record the remaining disagreement', exact: true }),
  ).toBeVisible();
  expect(corral.server.coordinator.listRuns().map((run) => run.runId)).toEqual(runs);
  expect((await meeting(page, id)).rounds).toHaveLength(3);
  expect(corral.errors).toEqual([]);
});

test.describe('active meeting', () => {
  let replies = new Gate();
  test.use({
    agentReply: { reply: () => 'A considered answer.', beforeReply: () => replies.wait() },
  });
  test.beforeEach(() => {
    replies = new Gate();
  });
  test.afterEach(() => {
    replies.open();
  });
  test('[TC-MEET-001-N] [TC-MEET-001-F] edits one waiting message and stops both rounds', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    const id = await createMeeting(page, corral);
    await send(page, 'Take time to consider this');
    await expect(page.getByRole('button', { name: 'Stop round', exact: true })).toBeVisible();
    await send(page, '@Architect original follow-up');
    await page.getByRole('button', { name: 'Edit queued message', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Waiting message', exact: true })
      .fill('@Architect corrected follow-up');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect
      .poll(async () => (await meeting(page, id)).queued?.text)
      .toBe('@Architect corrected follow-up');
    await page
      .getByRole('textbox', { name: 'Meeting message', exact: true })
      .fill('Cannot replace the queued message');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.getByRole('textbox', { name: 'Meeting message', exact: true }).press('Enter');
    expect((await meeting(page, id)).queued?.text).toBe('@Architect corrected follow-up');
    await page.getByRole('button', { name: 'Stop round', exact: true }).click();
    const firstReplies = replies;
    replies = new Gate();
    firstReplies.open();
    const next = page.getByRole('region', { name: '@Architect corrected follow-up', exact: true });
    await expect(next.getByRole('article')).toHaveCount(1);
    await next.getByRole('button', { name: 'Stop round', exact: true }).click();
    replies.open();
    await expect
      .poll(async () =>
        (await meeting(page, id)).rounds.every(
          (round) => !round.active && Boolean(round.stoppedAt),
        ),
      )
      .toBe(true);
    await page.reload();
    await expect(
      page.getByText('You stopped this round. Answers already received stay in the record.', {
        exact: true,
      }),
    ).toHaveCount(2);
    expect((await meeting(page, id)).rounds.map((round) => round.message)).toEqual([
      'Take time to consider this',
      '@Architect corrected follow-up',
    ]);
    expect(corral.server.coordinator.listRuns()).toHaveLength(3);
    expect(corral.errors).toEqual([]);
  });
});

test('[TC-MEET-002-H] [TC-MEET-002-N] minutes retain dissent and only a human adopts or withdraws a decision', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const id = await createMeeting(page, corral);
  await adoptDecision(page, id);
  const state = await meeting(page, id);
  expect(state.minutes?.[0]?.document?.remainingDissent[0]?.text).toBe(
    'Measure latency before release.',
  );
  expect(state.decisions?.[0]?.content).toMatchObject({
    goal: 'Measure before releasing',
    actions: ['Measure latency'],
    remainingDissent: ['Builder requires latency measurements before release.'],
  });
  await expect(
    page.getByText('Builder requires latency measurements before release.', { exact: true }),
  ).toHaveCount(2);
  expect(corral.server.coordinator.listRuns()).toHaveLength(3);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Withdraw decision', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Reason for withdrawal', exact: true })
    .fill('Need another measurement first');
  await page.getByRole('button', { name: 'Record withdrawal', exact: true }).click();
  await expect
    .poll(async () => (await meeting(page, id)).decisionWithdrawals?.[0]?.reason)
    .toBe('Need another measurement first');
  await page.reload();
  await page.getByText('Minutes, decisions and handoffs', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hand off to work', exact: true })).toHaveCount(0);
  expect((await meeting(page, id)).decisions).toHaveLength(1);
  expect(corral.server.coordinator.listRuns()).toHaveLength(3);
  expect(corral.errors).toEqual([]);
});

test('[TC-MEET-003-H] [TC-MEET-003-N] handoffs preserve existing input and start work only when requested', async ({
  page,
  corral,
}) => {
  test.setTimeout(60_000);
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const targetId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await requestBox(page).fill('Keep my unsent request');
  const targetTitle = (await session(page, targetId)).title;
  const id = await createMeeting(page, corral);
  await adoptDecision(page, id);
  const handoffs = async (): Promise<MeetingHandoffReceipt[]> => {
    const response = await page.request.get(
      new URL(`/api/v1/sessions/${id}/meeting-handoffs`, page.url()).href,
    );
    expect(response.ok()).toBeTruthy();
    return (await response.json()).handoffs;
  };
  await page.getByRole('button', { name: 'Hand off to work', exact: true }).click();
  await page.getByRole('combobox', { name: 'Target session', exact: true }).click();
  await page.getByRole('option', { name: targetTitle, exact: true }).click();
  await page.getByRole('button', { name: 'Hand off and start', exact: true }).click();
  await expect.poll(async () => (await handoffs())[0]?.state).toBe('drafted');
  expect(corral.server.coordinator.listRuns()).toHaveLength(3);
  expect((await session(page, targetId)).corralId).toBeNull();
  await page.goto(`${corral.server.url}/sessions/${targetId}`);
  await expect(requestBox(page)).toHaveValue('Keep my unsent request');
  await expect(
    page.getByRole('link', { name: 'Open source meeting', exact: true }),
  ).toHaveAttribute('href', `/sessions/${id}`);

  await page.goto(`${corral.server.url}/sessions/${id}`);
  await page.getByText('Minutes, decisions and handoffs', { exact: true }).click();
  await page.getByRole('button', { name: 'Hand off to work', exact: true }).click();
  await page.getByRole('textbox', { name: 'New session name', exact: true }).fill('Saved handoff');
  await page.getByRole('button', { name: 'Hand off as draft', exact: true }).click();
  await expect.poll(async () => (await handoffs()).length).toBe(2);
  expect((await handoffs())[0]).toMatchObject({ state: 'drafted', runId: null });
  expect((await handoffs())[0]?.targetSessionId).not.toBe(targetId);
  expect(corral.server.coordinator.listRuns()).toHaveLength(3);

  await page
    .getByRole('textbox', { name: 'New session name', exact: true })
    .fill('Started handoff');
  await page.getByRole('button', { name: 'Hand off and start', exact: true }).click();
  await expect
    .poll(
      async () => (await handoffs()).find((receipt) => receipt.state === 'started')?.result?.status,
    )
    .toBe('succeeded');
  const started = (await handoffs()).find((receipt) => receipt.state === 'started');
  if (!started) throw new Error('The handoff must start a work session Run.');
  expect(started.runId).toBeTruthy();
  expect((await session(page, started.targetSessionId)).corralId).toBeNull();
  expect((await session(page, started.targetSessionId)).entries).toContainEqual(
    expect.objectContaining({ runId: started.runId, state: 'started' }),
  );
  await expect(
    page.getByRole('link', { name: /Open run/ }).filter({ hasText: 'succeeded' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Discuss this result', exact: true }).click();
  await expect.poll(async () => (await meeting(page, id)).rounds.length).toBe(3);
  const discussion = (await meeting(page, id)).rounds[2]?.message;
  expect(discussion).toContain(`Run: ${started.runId}`);
  expect(discussion).toContain(`Artifact: ${started.result?.artifactVersionId}`);
  expect(discussion).toContain('Keep one service and preserve the API.');
  expect(corral.errors).toEqual([]);
});
