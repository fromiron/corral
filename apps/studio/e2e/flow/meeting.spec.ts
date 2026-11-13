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

/**
 * Watches from now until the returned call: the items already on screen move at most 1px, the
 * input not at all, and the activity bar keeps its height (features/composer-flow.md "활동 바").
 */
async function watch(page: Page, name: string) {
  const probe = createProbe(page, probeOptions);
  await probe.start(name);
  await page.evaluate(() => {
    const samples = { heights: [] as number[], running: true };
    (window as unknown as { __barHeights: typeof samples }).__barHeights = samples;
    const sample = () => {
      const bar = document.querySelector('[data-testid="activity-bar"]');
      if (bar) samples.heights.push(bar.getBoundingClientRect().height);
      if (samples.running) requestAnimationFrame(sample);
    };
    sample();
  });
  return async () => {
    await waitForStill(page);
    const result = await probe.stop();
    const bar = await page.evaluate(() => {
      const samples = (
        window as unknown as { __barHeights: { heights: number[]; running: boolean } }
      ).__barHeights;
      samples.running = false;
      return samples.heights.length
        ? Math.max(...samples.heights) - Math.min(...samples.heights)
        : null;
    });
    expectStill(result);
    expect(bar, `${name}: activity bar height`).toBe(0);
    return result;
  };
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
    let done = await watch(page, 'meeting-auto');
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
    await done();
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
    done = await watch(page, 'meeting-how-chosen');
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
    await done();

    // No one again, after the answer, with Alt+Enter: every key sends to the meeting.
    done = await watch(page, 'meeting-none');
    await forNoOne('Noting the launch date for the release notes', 'Alt+Enter');
    await waitForStill(page);
    await done();
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
    let done = await watch(page, 'meeting-hold-arrives');
    await box.press('Enter');
    await expect(box).toHaveValue('');
    const card = tray.locator('[data-meeting-hold]');
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => gated, { timeout: 60_000 }).toBe(true);
    await waitForStill(page);
    await done();
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
    done = await watch(page, 'meeting-hold-folds');
    continued = true;
    await press.click();
    await expect(tray).toHaveCount(0, { timeout: 30_000 });
    await expect(box).toBeFocused();
    await waitForStill(page);
    await done();
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

  // Read from above while the chain goes on: an answer that starts gets its row at the end (none
  // stood there for it while it waited), and the reader's rows stay where they are on screen.
  test('answers starting while the person reads above leave their place', async ({
    page,
    corral,
  }) => {
    test.setTimeout(240_000);
    let id = '';
    let mention = '';
    let requests = 0;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    corral.fake?.setResponses(
      Array.from({ length: 120 }, () => async () => {
        requests += 1;
        // The fourth answer waits until the person has scrolled up.
        if (requests === 4) {
          reach();
          await opened;
        }
        if ((await meeting(page, id)).hold) return fauxAssistantMessage('Agreed.');
        return fauxAssistantMessage(`${mention} ${ANSWER}`);
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
    const timeline = page.getByTestId('chat-timeline');

    await box.fill('Which day should we launch?');
    await box.press('Enter');
    await reached;
    await waitForStill(page);
    // Read from above: the wheel takes the conversation well away from its end.
    await timeline.hover({ position: { x: 16, y: 200 } });
    for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, -500);
    await waitForStill(page);
    const gap = () =>
      timeline.evaluate((element) => {
        const scroller = element.matches('[data-slot="scroll-area-viewport"]')
          ? element
          : (element.closest('[data-slot="scroll-area-viewport"]') ?? element);
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      });
    expect(await gap()).toBeGreaterThan(400);

    const done = await watch(page, 'meeting-answers-start-reading');
    open();
    await expect(page.locator('[data-meeting-hold]')).toHaveCount(1, { timeout: 120_000 });
    await expect
      .poll(
        async () =>
          (await meeting(page, id)).rounds.every((round) =>
            round.answers.every((item) => item.status === 'answered'),
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    const result = await done();
    // Where the reader is, nothing moved, on screen or in the conversation.
    expect(result.maxViewportShiftPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    expect(requests).toBeGreaterThan(4);
    // The card is out of view: the activity bar says it and goes to it.
    await expect(page.getByTestId('activity-bar')).toHaveAttribute('data-line', 'hold');
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

  // A continue the server applied whose receipt never came back: the meeting is read once more.
  // Answered by keys, the focus goes to the new card's Continue when the chain is held again,
  // and to the message box when nothing holds any more.
  test('a continue whose receipt is lost hands the focus on to what came', async ({
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
    id = await newMeeting(page);
    const { config } = await meeting(page, id);
    mention = config.participants.map((person) => `@${person.participantId}`).join(' ');
    const composer = page.getByTestId('chat-composer');
    const box = composer.getByRole('textbox', { name: 'Meeting message', exact: true });
    const tray = page.locator('[data-pending-tray]');
    const press = tray.getByRole('button', { name: 'Continue', exact: true });
    const settled = async () => {
      const view = await meeting(page, id);
      return view.rounds.every((round) =>
        round.answers.every((item) => item.status === 'answered'),
      );
    };
    // Applied by the server; the answer is lost on its way back.
    const loseReceipt = () =>
      page.route(
        '**/meeting/continue',
        async (route) => {
          await route.fetch();
          await route.abort('failed');
        },
        { times: 1 },
      );

    await box.fill('Which day should we launch?');
    await box.press('Enter');
    await expect(press).toBeEnabled({ timeout: 120_000 });
    await expect.poll(settled, { timeout: 120_000 }).toBe(true);

    // Held again at once after the continue: a new card, and the focus on its Continue.
    quiet = true;
    await loseReceipt();
    await press.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await meeting(page, id)).rounds.filter((round) => round.continued).length)
      .toBe(1);
    await expect(press).toBeEnabled({ timeout: 30_000 });
    await expect(press).toBeFocused();

    // Pressed again, lost again; nothing holds now: the focus goes to the message box.
    await expect.poll(settled, { timeout: 120_000 }).toBe(true);
    await loseReceipt();
    await page.keyboard.press('Enter');
    await expect(tray).toHaveCount(0, { timeout: 30_000 });
    await expect(box).toBeFocused();
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

/** A new meeting, opened; its id. */
async function newMeeting(page: Page) {
  await page.getByRole('button', { name: 'New meeting', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a meeting' });
  await dialog.getByLabel('Meeting name', { exact: true }).fill('Launch day');
  await dialog.getByRole('button', { name: 'Create meeting', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
}

/**
 * Every answer that started has its row, and none that never started has one; there was at least
 * one of those, so the case was there to see.
 */
async function expectRowsOfStartedOnly(page: Page, id: string) {
  const view = await meeting(page, id);
  const answers = view.rounds.flatMap((round) =>
    round.answers.map((item) => ({
      row: `${round.roundId}:${item.participantId}`,
      started: item.order !== undefined || item.runId !== null,
    })),
  );
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-chat-item]')].map((item) =>
      item.getAttribute('data-chat-item'),
    ),
  );
  const never = answers.filter((item) => !item.started).map((item) => item.row);
  expect(never.length, 'answers that never started').toBeGreaterThan(0);
  expect(rows.filter((row) => row && never.includes(row))).toEqual([]);
  for (const item of answers.filter((answer) => answer.started))
    expect(rows, `${item.row} started`).toContain(item.row);
}

/** The stop commands the page sends from now on. */
function stopRequests(page: Page) {
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/meeting\/rounds\/[^/]+\/stop$/.test(request.url()))
      sent.push(request.url());
  });
  return sent;
}

// A stop (workbench.md, the meeting): answers that never started have no row, whatever became of
// them, and one stop leaves one line, at the end of the timeline as it was when the person
// stopped; nothing already on screen moves. Stop that just took Send's place is not pressed by a
// press meant for Send (composer-flow.md "활동 바").
test.describe('a meeting stopped', () => {
  test.use({
    live: true,
    codexLogin: true,
    streamTokensPerSecond: 60,
    meetingScores: [0.1, 0.9, 0.1],
  });

  for (const reduced of [false, true])
    test(`Send's place, pressed again just after sending, does not stop${reduced ? ', reduced motion' : ''}`, async ({
      page,
      corral,
    }) => {
      test.setTimeout(120_000);
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      corral.fake?.setResponses(
        Array.from({ length: 4 }, () => async () => {
          await opened;
          return fauxAssistantMessage('Tuesday.');
        }),
      );
      await corral.open('/projects/default');
      await newMeeting(page);
      const composer = page.getByTestId('chat-composer');
      const box = composer.getByRole('textbox', { name: 'Meeting message', exact: true });
      const stops = stopRequests(page);
      try {
        // The empty room's centred composer goes to the bottom with the first message.
        await composer.locator('[data-slot="composer-target"]').click();
        await page.getByRole('menuitemradio', { name: 'No one', exact: true }).click();
        await box.fill('The launch is next week');
        await box.press('Enter');
        await expect(
          page.getByTestId('chat-timeline').getByText('The launch is next week'),
        ).toBeVisible();
        await waitForStill(page);
        await box.fill('Which day should we launch?');
        await waitForStill(page);
        const send = composer.getByRole('button', { name: 'Send', exact: true });
        const spot = await send.boundingBox();
        if (!spot) throw new Error('Send is missing');
        const x = spot.x + spot.width / 2;
        const y = spot.y + spot.height / 2;
        await page.mouse.click(x, y);
        const stop = page.getByTestId('composer-stop');
        await expect(stop).toBeVisible();
        // Pressed again on the same place, 300, 450 and 550 ms after sending.
        for (const wait of [300, 150, 100]) {
          await page.waitForTimeout(wait);
          await page.mouse.click(x, y);
        }
        await page.waitForTimeout(200);
        expect(stops).toEqual([]);
        // Then it is Stop, and stops.
        await expect(stop).toBeEnabled({ timeout: 2_000 });
        await stop.click();
        await expect.poll(() => stops.length).toBe(1);
        expect(corral.errors).toEqual([]);
      } finally {
        open();
      }
    });

  test('a note posted while a mention chain answers, then a stop: one line, after the note', async ({
    page,
    corral,
  }) => {
    test.setTimeout(180_000);
    let id = '';
    let mention = '';
    let requests = 0;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    // The pick mentions the other two; the first of them answers and does not finish.
    corral.fake?.setResponses(
      Array.from({ length: 6 }, () => async () => {
        requests += 1;
        if (requests === 1) return fauxAssistantMessage(`${mention} what do you think?`);
        await opened;
        return fauxAssistantMessage('Agreed.');
      }),
    );
    await corral.open('/projects/default');
    id = await newMeeting(page);
    const { config } = await meeting(page, id);
    const [first, picked, third] = config.participants;
    if (!first || !picked || !third) throw new Error('three participants');
    mention = `@${first.participantId} @${third.participantId}`;
    const composer = page.getByTestId('chat-composer');
    const box = composer.getByRole('textbox', { name: 'Meeting message', exact: true });
    const recipients = composer.locator('[data-slot="composer-target"]');
    const timeline = page.getByTestId('chat-timeline');
    try {
      await box.fill('Which day should we launch?');
      await box.press('Enter');
      // One answers in the chain, the other waits.
      await expect
        .poll(
          async () =>
            (await meeting(page, id)).rounds
              .flatMap((round) => round.answers)
              .map((item) => item.status)
              .sort()
              .join(','),
          { timeout: 60_000 },
        )
        .toBe('answered,running,waiting');
      await recipients.click();
      await page.getByRole('menuitemradio', { name: 'No one', exact: true }).click();
      await box.fill('Noting this for the release notes');
      await box.press('Enter');
      await expect(timeline.getByText('Noting this for the release notes')).toBeVisible();
      await waitForStill(page, { stillMs: 600 });
      const done = await watch(page, 'meeting-stop-after-note');
      await page.getByTestId('composer-stop').click();
      const line = timeline.getByText(/^You stopped the replies\./);
      await expect(line).toHaveCount(1, { timeout: 30_000 });
      await waitForStill(page);
      await done();
      // The line is the last item; the one who never started has no row.
      const last = await page.evaluate(
        () => [...document.querySelectorAll('[data-chat-item]')].at(-1)?.textContent ?? '',
      );
      expect(last).toContain('You stopped the replies.');
      await expectRowsOfStartedOnly(page, id);
      await expect(page.getByTestId('chat-composer').getByRole('textbox')).toBeFocused();
      expect(corral.errors).toEqual([]);
    } finally {
      open();
    }
  });

  test('a question, a follow-up while it is answered, then a stop: one line, after the follow-up', async ({
    page,
    corral,
  }) => {
    test.setTimeout(180_000);
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    corral.fake?.setResponses(
      Array.from({ length: 6 }, () => async () => {
        await opened;
        return fauxAssistantMessage('Agreed.');
      }),
    );
    await corral.open('/projects/default');
    const id = await newMeeting(page);
    const { config } = await meeting(page, id);
    const [first, picked, third] = config.participants;
    if (!first || !picked || !third) throw new Error('three participants');
    const composer = page.getByTestId('chat-composer');
    const box = composer.getByRole('textbox', { name: 'Meeting message', exact: true });
    const timeline = page.getByTestId('chat-timeline');
    try {
      await box.fill(`@${first.participantId} @${third.participantId} which day should we launch?`);
      await box.press('Enter');
      // Both asked answer at once, and neither finishes.
      await expect
        .poll(async () => (await meeting(page, id)).rounds[0]?.answers.map((item) => item.status), {
          timeout: 60_000,
        })
        .toEqual(['running', 'running']);
      await box.fill('And who writes the announcement?');
      await box.press('Enter');
      await expect(timeline.getByText('And who writes the announcement?')).toBeVisible();
      await waitForStill(page, { stillMs: 600 });
      const done = await watch(page, 'meeting-stop-after-follow-up');
      await page.getByTestId('composer-stop').click();
      const line = timeline.getByText(/^You stopped the replies\./);
      await expect(line).toHaveCount(1, { timeout: 30_000 });
      await waitForStill(page);
      await done();
      const last = await page.evaluate(
        () => [...document.querySelectorAll('[data-chat-item]')].at(-1)?.textContent ?? '',
      );
      expect(last).toContain('You stopped the replies.');
      // The follow-up's answer, waiting its turn, never started: it has no row.
      await expectRowsOfStartedOnly(page, id);
      expect(corral.errors).toEqual([]);
    } finally {
      open();
    }
  });
});
