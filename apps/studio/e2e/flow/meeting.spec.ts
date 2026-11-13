import type { MeetingView } from '@corral/contracts';
import { fauxAssistantMessage } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

// Scene ⑦ (docs/plans/unified-flow.md §4.4; features/composer-flow.md "화면 틀", the send
// table's meeting row; workbench.md "회의"): a meeting is read in the conversation's frame with
// the conversation's composer. A person's message goes to whoever the meeting picks, the
// picked participant's answer streams in, and a message for no one is posted with nobody
// asked to reply. Sending, the answer streaming and the round ending move nothing already on
// screen, and the input line never moves.

const probeOptions = {
  itemSelector: '[data-chat-item]',
  rowSelector: '[data-sidebar-index][data-session-kind]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

function expectStill(result: ShiftResult) {
  expect(result.samples.frames, `${result.name}: frames`).toBeGreaterThan(0);
  expect(result.maxInputBottomChangePx ?? 0, `${result.name}: input`).toBe(0);
  const moved = result.items.filter(
    (item) =>
      item.kind === 'item' && Math.max(item.maxContainerShiftYPx, item.maxContainerShiftXPx) > 1,
  );
  expect(moved, `${result.name}: moved items`).toEqual([]);
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

async function meeting(page: Page, id: string): Promise<MeetingView> {
  const response = await page.request.get(
    new URL(`/api/v1/sessions/${id}/meeting`, page.url()).href,
  );
  expect(response.ok()).toBeTruthy();
  return response.json();
}

const ANSWER = `${'Launch on Tuesday: the rollout checklist is done and support is staffed. '.repeat(14)}That is my pick.`;

test.describe('a meeting in the conversation frame', () => {
  test.use({
    live: true,
    codexLogin: true,
    streamTokensPerSecond: 60,
    // The meeting's pick is scripted: the second participant fits every message best.
    meetingScores: [0.1, 0.9, 0.1],
  });

  test('a message the meeting answers, then a message for no one', async ({ page, corral }) => {
    test.setTimeout(180_000);
    let requests = 0;
    corral.fake?.setResponses([
      () => {
        requests += 1;
        return fauxAssistantMessage(ANSWER);
      },
    ]);
    await corral.open('/projects/default');
    await page.getByRole('button', { name: 'New meeting', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a meeting' });
    await dialog.getByLabel('Meeting name', { exact: true }).fill('Launch day');
    await dialog.getByRole('button', { name: 'Create meeting', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);
    const id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    const { config } = await meeting(page, id);
    expect(config.participants).toHaveLength(3);
    const picked = must(config.participants[1], 'the second participant');

    const composer = page.getByTestId('chat-composer');
    const box = composer.getByRole('textbox', { name: 'Meeting message', exact: true });
    // The conversation's composer: the recipients sit where a conversation's target does.
    await expect(composer.locator('[data-slot="composer-shell"]')).toBeVisible();
    const recipients = composer.locator('[data-slot="composer-target"]');
    await expect(recipients).toHaveAccessibleName('Recipients: Auto');
    await expect(composer.locator('[data-slot="composer-key"]')).toHaveCount(1);
    const timeline = page.getByTestId('chat-timeline');
    const forNoOne = async (text: string, key: string) => {
      await recipients.click();
      await page.getByRole('menuitemradio', { name: 'No one', exact: true }).click();
      await expect(recipients).toHaveAccessibleName('Recipients: No one');
      await box.fill(text);
      await waitForStill(page);
      await box.press(key);
      await expect(box).toHaveValue('');
      await expect(timeline.getByText(text, { exact: true })).toBeVisible();
      // A sent message's recipients go with it.
      await expect(recipients).toHaveAccessibleName('Recipients: Auto');
    };

    // No one: posted, and nobody is asked to reply. The first message also takes the empty
    // room's centred composer to the bottom, as in an empty conversation; that is not measured.
    await forNoOne('The launch is next week', 'Enter');
    const posted = must((await meeting(page, id)).rounds[0], 'the posted round');
    expect(posted.participantIds).toEqual([]);
    expect(posted.answers).toEqual([]);
    expect(posted.selection).toMatchObject({ strategy: 'none', reason: 'no_recipients' });
    expect(requests).toBe(0);

    // A message for whoever the meeting picks: the pick answers as it streams, and only the pick.
    await box.fill('Which day should we launch?');
    await waitForStill(page);
    let probe = createProbe(page, probeOptions);
    await probe.start('meeting-auto');
    await box.press('Enter');
    await expect(box).toHaveValue('');
    const answer = timeline.getByRole('article', { name: picked.name });
    await expect(answer).toContainText('Launch on Tuesday', { timeout: 30_000 });
    await expect
      .poll(async () => (await meeting(page, id)).rounds[1]?.answers[0]?.status, {
        timeout: 60_000,
      })
      .toBe('answered');
    await expect(answer).toContainText('That is my pick.');
    await waitForStill(page);
    expectStill(await probe.stop());
    const asked = must((await meeting(page, id)).rounds[1], 'the answered round');
    expect(asked.participantIds).toEqual([picked.participantId]);
    expect(asked.selection).toMatchObject({ strategy: 'selector', reason: 'top_score' });
    expect(asked.answers.map((item) => item.participantId)).toEqual([picked.participantId]);
    expect(requests).toBe(1);

    // No one again, after the answer, with Alt+Enter: every key sends to the meeting.
    probe = createProbe(page, probeOptions);
    await probe.start('meeting-none');
    await forNoOne('Noting the launch date for the release notes', 'Alt+Enter');
    await waitForStill(page);
    expectStill(await probe.stop());
    const noted = must((await meeting(page, id)).rounds[2], 'the second posted round');
    expect(noted.participantIds).toEqual([]);
    expect(noted.answers).toEqual([]);
    expect(requests).toBe(1);
    expect(corral.errors).toEqual([]);
  });
});
