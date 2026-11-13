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
  // Null, when the input was never found, fails too.
  expect(result.maxInputBottomChangePx, `${result.name}: input`).toBe(0);
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

/**
 * Follows the input box's top and bottom edges on screen every frame, from now until the
 * returned stop, which gives how far each moved (max − min); null when the box was not found.
 */
async function trackInputEdges(page: Page) {
  await page.evaluate(() => {
    const edges = { top: [] as number[], bottom: [] as number[], running: true };
    (window as unknown as { __inputEdges: typeof edges }).__inputEdges = edges;
    const sample = () => {
      const box = document.querySelector('[data-testid="chat-composer"] textarea');
      if (box) {
        const rect = box.getBoundingClientRect();
        edges.top.push(rect.top);
        edges.bottom.push(rect.bottom);
      }
      if (edges.running) requestAnimationFrame(sample);
    };
    sample();
  });
  return () =>
    page.evaluate(() => {
      const edges = (
        window as unknown as { __inputEdges: { top: number[]; bottom: number[]; running: boolean } }
      ).__inputEdges;
      edges.running = false;
      const spread = (values: number[]) =>
        values.length < 2
          ? null
          : Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10;
      return { top: spread(edges.top), bottom: spread(edges.bottom), frames: edges.top.length };
    });
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

    // How the meeting picked: Auto, on the message's meta line, opens the reason and the scores,
    // the pick first; opening and closing it moves nothing.
    const auto = timeline.getByRole('button', {
      name: 'Auto: how the recipients were chosen',
      exact: true,
    });
    await expect(auto).toHaveCount(1);
    await waitForStill(page);
    probe = createProbe(page, probeOptions);
    await probe.start('meeting-how-chosen');
    await auto.click();
    const how = page.getByRole('dialog', { name: 'How the recipients were chosen', exact: true });
    await expect(how).toContainText('the best fit for this message');
    const ranking = how.getByRole('list', { name: 'Fit for this message', exact: true });
    await expect(ranking.getByRole('listitem')).toHaveCount(3);
    await expect(ranking.getByRole('listitem').first()).toContainText(picked.name);
    await expect(ranking.locator('[data-picked]')).toHaveCount(1);
    await waitForStill(page);
    await page.keyboard.press('Escape');
    await expect(how).toHaveCount(0);
    await expect(auto).toBeFocused();
    await waitForStill(page);
    expectStill(await probe.stop());

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

  // Participants who keep mentioning each other are held after eight mention rounds; the hold is
  // a continue card at the timeline's end, pressable while an answer still runs. It arrives and
  // folds without moving what is on screen, and continuing marks where the replies went on.
  test('a held mention chain waits on a continue card at the end', async ({ page, corral }) => {
    test.setTimeout(240_000);
    let id = '';
    let mention = '';
    let continued = false;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let gated = false;
    // Every answer mentions everyone until the meeting holds; then the next answer waits, so it
    // is still running beside the card, and after Continue nobody mentions anyone.
    corral.fake?.setResponses(
      Array.from({ length: 120 }, () => async () => {
        if (continued) return fauxAssistantMessage('Agreed, Tuesday it is.');
        if ((await meeting(page, id)).hold) {
          gated = true;
          await opened;
          return fauxAssistantMessage('Agreed.');
        }
        return fauxAssistantMessage(`${mention} what do you think?`);
      }),
    );
    await corral.open('/projects/default');
    await page.getByRole('button', { name: 'New meeting', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a meeting' });
    await dialog.getByLabel('Meeting name', { exact: true }).fill('Launch day');
    await dialog.getByRole('button', { name: 'Create meeting', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);
    id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    const { config } = await meeting(page, id);
    mention = config.participants.map((person) => `@${person.participantId}`).join(' ');
    const composer = page.getByTestId('chat-composer');
    const box = composer.getByRole('textbox', { name: 'Meeting message', exact: true });
    const recipients = composer.locator('[data-slot="composer-target"]');
    const timeline = page.getByTestId('chat-timeline');
    const tray = page.locator('[data-pending-tray]');

    // The first message takes the empty room's centred composer to the bottom; not measured.
    await recipients.click();
    await page.getByRole('menuitemradio', { name: 'No one', exact: true }).click();
    await box.fill('The launch is next week');
    await box.press('Enter');
    await expect(timeline.getByText('The launch is next week', { exact: true })).toBeVisible();
    await waitForStill(page);

    // The chain runs and is held; the card arrives at the end, and nothing on screen moves.
    await box.fill('Which day should we launch?');
    await waitForStill(page);
    let probe = createProbe(page, probeOptions);
    await probe.start('meeting-hold-arrives');
    await box.press('Enter');
    await expect(box).toHaveValue('');
    const card = tray.locator('[data-meeting-hold]');
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => gated, { timeout: 60_000 }).toBe(true);
    await waitForStill(page);
    expectStill(await probe.stop());
    await expect(tray).toHaveCount(1);
    const atTheEnd = await page.evaluate(() => {
      const element = document.querySelector('[data-pending-tray]');
      const last = [...document.querySelectorAll('[data-chat-item]')].at(-1);
      const composer = document.querySelector('[data-testid="chat-composer"]');
      if (!element || !last || !composer) return null;
      return {
        afterLast: Boolean(
          last.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING &&
            !last.contains(element),
        ),
        aboveComposer:
          element.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 1,
      };
    });
    expect(atTheEnd).toEqual({ afterLast: true, aboveComposer: true });
    const held = await meeting(page, id);
    expect(held.hold).toMatchObject({ kind: 'chain' });
    // An answer still runs beside the card, and the card can be pressed.
    await expect(
      composer.getByRole('button', { name: 'Stop answering', exact: true }),
    ).toBeVisible();
    const press = card.getByRole('button', { name: 'Continue', exact: true });
    await expect(press).toBeEnabled();

    // Continued: the card folds and leaves, the focus goes to the box, and nothing moves.
    probe = createProbe(page, probeOptions);
    await probe.start('meeting-hold-folds');
    continued = true;
    await press.click();
    await expect(tray).toHaveCount(0, { timeout: 30_000 });
    await expect(box).toBeFocused();
    await waitForStill(page);
    expectStill(await probe.stop());
    open();
    await expect
      .poll(
        async () => {
          const view = await meeting(page, id);
          return (
            view.rounds.some((round) => round.continued) &&
            view.rounds.every((round) => round.answers.every((item) => item.status === 'answered'))
          );
        },
        { timeout: 120_000 },
      )
      .toBe(true);
    const after = await meeting(page, id);
    expect(after.hold).toBeUndefined();
    expect(after.rounds.filter((round) => round.continued)).toHaveLength(1);
    // The line says once where the replies went on. The timeline draws only what is near the
    // view, and the answers after it may have taken it out: read back up to it.
    const line = timeline.getByText('You continued the replies here.', { exact: true });
    await waitForStill(page);
    await timeline.hover({ position: { x: 16, y: 200 } });
    for (let step = 0; step < 40 && (await line.count()) === 0; step += 1) {
      await page.mouse.wheel(0, -300);
      await waitForStill(page);
    }
    await expect(line).toHaveCount(1);
    expect(corral.errors).toEqual([]);
  });

  // Every answer mentions everyone and nothing waits: once all have answered, a continue follows
  // the held mentions and the meeting holds again in the same call, after the same round. That is
  // a new card with a new command, pressed again; continuing never leaves a card that cannot be.
  test('a chain held again after a continue gets a new card, pressed again', async ({
    page,
    corral,
  }) => {
    test.setTimeout(240_000);
    let id = '';
    let mention = '';
    let quiet = false;
    corral.fake?.setResponses(
      Array.from(
        { length: 200 },
        () => () =>
          fauxAssistantMessage(quiet ? 'Agreed, Tuesday it is.' : `${mention} what do you think?`),
      ),
    );
    await corral.open('/projects/default');
    await page.getByRole('button', { name: 'New meeting', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a meeting' });
    await dialog.getByLabel('Meeting name', { exact: true }).fill('Launch day');
    await dialog.getByRole('button', { name: 'Create meeting', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);
    id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    const { config } = await meeting(page, id);
    mention = config.participants.map((person) => `@${person.participantId}`).join(' ');
    const composer = page.getByTestId('chat-composer');
    const box = composer.getByRole('textbox', { name: 'Meeting message', exact: true });
    const tray = page.locator('[data-pending-tray]');
    const press = tray.getByRole('button', { name: 'Continue', exact: true });
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/meeting/continue'))
        sent.push((request.postDataJSON() as { commandId: string }).commandId);
    });
    const settled = async () => {
      const view = await meeting(page, id);
      return view.rounds.every((round) =>
        round.answers.every((item) => item.status === 'answered'),
      );
    };

    await box.fill('Which day should we launch?');
    await box.press('Enter');
    await expect(press).toBeEnabled({ timeout: 120_000 });
    await expect.poll(settled, { timeout: 120_000 }).toBe(true);
    const first = must((await meeting(page, id)).hold, 'the first hold');

    // Continued with every answer in: held again at once, after the same round.
    quiet = true;
    await press.click();
    await expect
      .poll(async () => (await meeting(page, id)).rounds.filter((round) => round.continued).length)
      .toBe(1);
    const again = (await meeting(page, id)).hold;
    expect(again).toEqual(first);
    // A new card: pressable, not left as Continued.
    await expect(press).toBeEnabled({ timeout: 30_000 });
    await expect(tray.getByText('Continued', { exact: true })).toHaveCount(0);

    // Pressed again, with a command of its own; the hold is released and the card goes.
    await expect.poll(settled, { timeout: 120_000 }).toBe(true);
    await press.click();
    await expect(tray).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(settled, { timeout: 120_000 }).toBe(true);
    expect((await meeting(page, id)).hold).toBeUndefined();
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    expect(corral.errors).toEqual([]);
  });

  // Under 640px the kit's tool line wraps; what the meeting puts on it keeps one width whatever
  // the recipients are and whether someone answers, so the line, and the input above it, stay.
  for (const width of [480, 390]) {
    test(`at ${width}px the input holds still while the recipients change and an answer runs`, async ({
      page,
      corral,
    }) => {
      test.setTimeout(180_000);
      corral.fake?.setResponses([() => fauxAssistantMessage(ANSWER)]);
      await page.setViewportSize({ width, height: 800 });
      await corral.open('/projects/default');
      await page.getByRole('button', { name: 'New meeting', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Create a meeting' });
      await dialog.getByLabel('Meeting name', { exact: true }).fill('Launch day');
      await dialog.getByRole('button', { name: 'Create meeting', exact: true }).click();
      await expect(page).toHaveURL(/\/sessions\/session_/);
      const id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
      const { config } = await meeting(page, id);
      const [first, second] = config.participants;
      const composer = page.getByTestId('chat-composer');
      const box = composer.getByRole('textbox', { name: 'Meeting message', exact: true });
      const recipients = composer.locator('[data-slot="composer-target"]');
      const timeline = page.getByTestId('chat-timeline');
      const choose = (role: 'menuitemradio' | 'menuitemcheckbox', name: string) =>
        page.getByRole(role, { name, exact: true }).click();

      // The first message takes the empty room's centred composer to the bottom; not measured.
      await recipients.click();
      await choose('menuitemradio', 'No one');
      await box.fill('The launch is next week');
      await box.press('Enter');
      await expect(timeline.getByText('The launch is next week', { exact: true })).toBeVisible();
      await waitForStill(page);

      // Auto → one name → two names → no one, and back to Auto.
      let stop = await trackInputEdges(page);
      await recipients.click();
      const firstName = must(first, 'the first participant').name;
      const secondName = must(second, 'the second participant').name;
      await choose('menuitemcheckbox', firstName);
      // Narrow, the chosen read as a count: the badge keeps its width; its name says who.
      await expect(recipients).toHaveAccessibleName(`Recipients (1 person): ${firstName}`);
      await choose('menuitemcheckbox', secondName);
      await expect(recipients).toHaveAccessibleName(
        `Recipients (2 people): ${firstName}, ${secondName}`,
      );
      await choose('menuitemradio', 'No one');
      await expect(recipients).toHaveAccessibleName('Recipients: No one');
      // A menu used gives the focus back to the box.
      await expect(box).toBeFocused();
      await recipients.click();
      await choose('menuitemradio', 'Auto');
      await expect(recipients).toHaveAccessibleName('Recipients: Auto');
      await expect(box).toBeFocused();
      await waitForStill(page);
      const changed = await stop();
      expect(changed.frames, `${width}: recipient frames`).toBeGreaterThan(1);
      expect(changed.top, `${width}: input top while the recipients change`).toBeLessThanOrEqual(1);
      expect(
        changed.bottom,
        `${width}: input bottom while the recipients change`,
      ).toBeLessThanOrEqual(1);

      // An answer starts (Stop appears) and ends (Stop goes).
      await box.fill('Which day?');
      await waitForStill(page);
      stop = await trackInputEdges(page);
      await box.press('Enter');
      await expect(box).toHaveValue('');
      await expect(
        composer.getByRole('button', { name: 'Stop answering', exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await meeting(page, id)).rounds[1]?.answers[0]?.status, {
          timeout: 60_000,
        })
        .toBe('answered');
      await expect(
        composer.getByRole('button', { name: 'Stop answering', exact: true }),
      ).toHaveCount(0);
      await waitForStill(page);
      const answered = await stop();
      expect(answered.frames, `${width}: answer frames`).toBeGreaterThan(1);
      expect(answered.top, `${width}: input top while an answer runs`).toBeLessThanOrEqual(1);
      expect(answered.bottom, `${width}: input bottom while an answer runs`).toBeLessThanOrEqual(1);
      console.log(`MEASURE ${width} ${JSON.stringify({ recipients: changed, answer: answered })}`);
      expect(corral.errors).toEqual([]);
    });
  }
});
