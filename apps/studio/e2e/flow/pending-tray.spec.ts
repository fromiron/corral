import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, type Harness, test } from '../server/harness.ts';
import {
  closePanel,
  closeSettings,
  maximizePanel,
  newConversation,
  openFolderSettings,
  openPanelTab,
  panelTabNamed,
  requestBox,
  sessionPanel,
} from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

/** The activity bar while its line tells of a waiting request. */
const waitingLine = (page: Page) =>
  page.locator('[data-testid="activity-bar"][data-line="waiting"]');

// Scene ④: a run waits on an approval and then a question, and
// both are answered in the conversation's needed-now tray (composer-flow.md "지금 필요한 것").
// The items already in the timeline hold their place within 1px while a card arrives and while
// it is answered; read from above, a card arriving at the end leaves the reader's place as it
// was. The approval lets the run go on, and the answer reaches the model's next request.
// Replies are one line, so nothing but the tray changes the timeline's height.

const OUT = join(import.meta.dirname, '..', '..', 'test-results', 'flow');
const RESULTS = join(OUT, 'pending-tray.json');

const probeOptions = {
  itemSelector: '[data-chat-item]',
  partSelector: '[data-chat-part]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

type Recorded = {
  container: number | null;
  viewport: number | null;
  lost: string[];
  tracked: number;
};

function record(name: string, result: ShiftResult) {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, Recorded> = existsSync(RESULTS)
    ? JSON.parse(readFileSync(RESULTS, 'utf8'))
    : {};
  results[name] = {
    container: result.maxContainerShiftPx,
    viewport: result.maxViewportShiftPx,
    lost: result.lost,
    tracked: result.samples.tracked.item,
  };
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
}

function hold() {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { open, opened, reach, reached };
}

/** The largest move of the items there at the start, over an interval that `happen` makes. */
async function measure(page: Page, name: string, happen: () => Promise<void>) {
  const probe = createProbe(page, probeOptions);
  await probe.start(name);
  await happen();
  await waitForStill(page);
  const result = await probe.stop();
  record(name, result);
  expect(result.samples.frames, `${name}: frames`).toBeGreaterThan(0);
  expect(result.samples.tracked.item, `${name}: items tracked`).toBeGreaterThan(0);
  expect(result.lost, `${name}: lost`).toEqual([]);
  return result;
}

/**
 * A conversation in a linked, trusted Git folder with its working copy made, so the
 * conversation's lead can run a command, which asks first.
 */
async function conversationWithWorkingCopy(page: Page, corral: Harness) {
  const original = mkdtempSync(join(tmpdir(), 'corral-tray-e2e-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('init', '-q');
  writeFileSync(join(original, 'README.md'), '# Tray\n');
  git('add', '.');
  git('commit', '-q', '-m', 'tray source');
  await corral.open('/');
  const folder = await openFolderSettings(page);
  await folder.getByLabel('Folder path on this computer').fill(original);
  await folder.getByRole('button', { name: 'Link folder' }).click();
  const trust = folder.getByRole('switch', { name: /Trust this repository/ });
  await trust.click();
  await expect(trust).toBeChecked();
  await closeSettings(page);
  await newConversation(page);
  const sessionId = new URL(page.url()).pathname.split('/')[2] as string;
  await openPanelTab(page, 'Changes');
  await page
    .getByRole('region', { name: 'Paddock' })
    .getByRole('button', { name: /Make a Paddock from/ })
    .click();
  await expect(page.getByRole('link', { name: 'Review changes', exact: true })).toBeVisible();
  // The conversation alone again, so the scene measures it at its own width.
  await closePanel(page);
  return { sessionId, cleanup: () => rm(original, { recursive: true, force: true }) };
}

/** Requests that never ran, added before the run so the conversation is taller than its view. */
async function earlier(page: Page, sessionId: string, count: number) {
  await page.evaluate(
    async ({ id, count }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      for (let index = 0; index < count; index += 1) {
        const response = await fetch(`/api/v1/sessions/${id}/entries`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify({
            intent: 'next',
            text: `Earlier request ${index + 1}. ${'Long enough to wrap over lines. '.repeat(3)}`,
            state: 'refused',
          }),
        });
        if (!response.ok) throw new Error(`earlier entry: ${response.status}`);
      }
    },
    { id: sessionId, count },
  );
}

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

const question = () =>
  tool('ask_user', {
    key: 'format',
    questions: [{ id: 'format', kind: 'text', prompt: 'Which format should I use?' }],
  });

const tray = (page: Page) => page.locator('[data-pending-tray]');

/** Buttons with exactly this text anywhere in the page, shown or kept hidden in another view. */
const buttonsNamed = (page: Page, name: string) =>
  page.evaluate(
    (name) =>
      [...document.querySelectorAll('button')].filter(
        (button) => button.textContent?.trim() === name,
      ).length,
    name,
  );

/** The tray stands after every item and inside the timeline, above the composer. */
async function trayAtTheEnd(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector('[data-pending-tray]');
    const timeline = document.querySelector('[data-testid="chat-timeline"]');
    const items = [...document.querySelectorAll('[data-chat-item]')];
    const last = items.at(-1);
    const composer = document.querySelector('[data-testid="chat-composer"]');
    if (!element || !timeline || !last || !composer) return null;
    const box = element.getBoundingClientRect();
    return {
      inTimeline: timeline.contains(element),
      afterLast: Boolean(
        last.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING &&
          !last.contains(element),
      ),
      aboveComposer: box.bottom <= composer.getBoundingClientRect().top + 1,
      inView: box.top >= timeline.getBoundingClientRect().top - 1,
    };
  });
}

test.use({ live: true, codexLogin: true });

test('the tray takes an approval and a question at the end and folds them once answered', async ({
  page,
  corral,
}) => {
  test.setTimeout(150_000);
  const asked = hold();
  const questioned = hold();
  let afterCommand = '';
  let afterAnswer = '';
  corral.fake?.setResponses([
    async () => {
      asked.reach();
      await asked.opened;
      return tool('run_command', { command: 'echo tray-ok' });
    },
    async (context) => {
      afterCommand = JSON.stringify(context.messages);
      questioned.reach();
      await questioned.opened;
      return question();
    },
    (context) => {
      afterAnswer = JSON.stringify(context.messages);
      return fauxAssistantMessage('Done, as a table.');
    },
  ]);
  const { cleanup } = await conversationWithWorkingCopy(page, corral);
  try {
    await requestBox(page).fill('Check the folder, then ask me how to report it.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await asked.reached;
    // The request and its run's row: one item.
    await expect(
      page.locator('[data-chat-item]').filter({ has: page.getByTestId('turn-run') }),
    ).toHaveCount(1);
    await waitForStill(page);
    expect(await tray(page).count()).toBe(0);

    // The approval arrives: at the end, once, and nothing already there moves.
    const card = tray(page).locator('[data-testid^="approval-"]');
    const arrived = await measure(page, 'approval-arrives', async () => {
      asked.open();
      await expect(card).toBeVisible({ timeout: 30_000 });
    });
    expect(arrived.maxContainerShiftPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    await expect(tray(page)).toHaveCount(1);
    expect(await trayAtTheEnd(page)).toEqual({
      inTimeline: true,
      afterLast: true,
      aboveComposer: true,
      inView: true,
    });
    // One way to answer it on the screen, and not in the run's row.
    expect(await buttonsNamed(page, 'Allow once')).toBe(1);
    await expect(page.locator('[data-chat-item] [data-approval]')).toHaveCount(0);
    // Enter and Escape decide nothing, wherever focus is in the tray.
    await tray(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await card.locator('p').first().click();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    const pending = () =>
      Object.values(
        corral.server.coordinator.getSnapshot(corral.server.coordinator.listRuns()[0]?.runId ?? '')
          .projection.approvals,
      ).filter((approval) => approval.status === 'pending').length;
    expect(pending()).toBe(1);
    await expect(card).toBeVisible();

    // Approved: the card leaves its place and the run goes on to its next request.
    const approved = await measure(page, 'approval-answered', async () => {
      await card.getByRole('button', { name: 'Allow once', exact: true }).click();
      await questioned.reached;
      await expect(card).toHaveCount(0);
    });
    expect(approved.maxContainerShiftPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    expect(afterCommand).toContain('tray-ok');

    // The question comes to the same place.
    const form = tray(page).getByRole('form', { name: 'Waiting for you' });
    const asking = await measure(page, 'question-arrives', async () => {
      questioned.open();
      await expect(form).toBeVisible({ timeout: 30_000 });
    });
    expect(asking.maxContainerShiftPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    await expect(tray(page)).toHaveCount(1);
    await expect(page.getByRole('form', { name: 'Waiting for you' })).toHaveCount(1);
    expect((await trayAtTheEnd(page))?.afterLast).toBe(true);

    // Answered: the answer is in the model's next request, and the tray leaves.
    const answered = await measure(page, 'question-answered', async () => {
      await form.getByRole('textbox', { name: 'Your answer' }).fill('A table');
      await form.getByRole('button', { name: 'Send answer' }).click();
      await expect(page.getByTestId('chat-result')).toContainText('Done, as a table.', {
        timeout: 30_000,
      });
    });
    expect(answered.maxContainerShiftPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    expect(afterAnswer).toContain('A table');
    await expect(tray(page)).toHaveCount(0);
    await expect
      .poll(() => corral.server.coordinator.listRuns()[0]?.status, { timeout: 30_000 })
      .toBe('succeeded');
    expect(corral.errors).toEqual([]);
  } finally {
    await cleanup();
  }
});

test('a card arriving while the person reads above leaves their place; Respond goes to it', async ({
  page,
  corral,
}) => {
  test.setTimeout(150_000);
  const asked = hold();
  corral.fake?.setResponses([
    async () => {
      asked.reach();
      await asked.opened;
      return tool('run_command', { command: 'echo tray-ok' });
    },
    fauxAssistantMessage('Done.'),
  ]);
  const { sessionId, cleanup } = await conversationWithWorkingCopy(page, corral);
  try {
    await earlier(page, sessionId, 24);
    await page.reload();
    await expect(page.locator('[data-chat-item]').first()).toBeVisible();
    await requestBox(page).fill('Check the folder.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await asked.reached;
    await waitForStill(page);
    // Read from above: the wheel takes the conversation well away from its end.
    const timeline = page.getByTestId('chat-timeline');
    await timeline.hover({ position: { x: 16, y: 200 } });
    for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, -500);
    await waitForStill(page);
    const gap = () =>
      timeline.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight);
    expect(await gap()).toBeGreaterThan(400);
    const before = await timeline.evaluate((box) => box.scrollTop);

    const arrived = await measure(page, 'approval-arrives-reading', async () => {
      asked.open();
      await expect(tray(page).locator('[data-testid^="approval-"]')).toHaveCount(1, {
        timeout: 30_000,
      });
    });
    // The reader's rows stay where they were on screen, and so does the scroll position.
    expect(arrived.maxViewportShiftPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    expect(arrived.maxContainerShiftPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
    expect(
      Math.abs((await timeline.evaluate((box) => box.scrollTop)) - before),
    ).toBeLessThanOrEqual(1);
    await expect(tray(page)).not.toBeInViewport();

    // The run record, beside the conversation, says the run waits and sends the person to the
    // tray to answer it: too narrow there for its response area, its head offers Respond.
    await openPanelTab(page, 'Runs');
    const monitor = page.getByTestId('run-monitor');
    const runTab = panelTabNamed(page, /^Run( #\d+)?$/);
    // Beside the conversation, Respond leaves the panel and its tab as they are.
    await monitor.getByTestId('run-respond').click();
    await expect(runTab).toHaveAttribute('aria-selected', 'true');
    await expect(sessionPanel(page)).toBeVisible();
    await expect(tray(page)).toBeFocused();
    await expect(tray(page)).toBeInViewport();
    // Maximized, the record has the room to read the request in its response area, which
    // offers Respond; the head's pill beside it only says the run waits.
    await maximizePanel(page);
    const respond = monitor.getByTestId('respond-in-conversation');
    await expect(respond).toBeVisible();
    await expect(monitor.getByTestId('run-respond')).toHaveCount(0);
    // The record reads it; the conversation keeps the one way to answer it.
    expect(await buttonsNamed(page, 'Allow once')).toBe(1);
    const record = monitor.locator('[data-approval]');
    await expect(record).toContainText('Tool permission');
    await expect(record.locator('[data-approval-action]')).toHaveCount(0);
    // Its Respond restores the panel beside the conversation, keeps the tab, and goes to the tray.
    await respond.click();
    await expect(sessionPanel(page).getByRole('button', { name: 'Maximize panel' })).toBeVisible();
    await expect(runTab).toHaveAttribute('aria-selected', 'true');
    await expect(tray(page)).toBeFocused();
    await expect(tray(page)).toBeInViewport();
    await tray(page).getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.getByTestId('chat-result')).toContainText('Done.', { timeout: 30_000 });
    await expect(tray(page)).toHaveCount(0);
    expect(corral.errors).toEqual([]);
  } finally {
    await cleanup();
  }
});

test('a question out of view is told above the composer, and Respond brings its card', async ({
  page,
  corral,
}) => {
  test.setTimeout(150_000);
  const asked = hold();
  corral.fake?.setResponses([
    async () => {
      asked.reach();
      await asked.opened;
      return question();
    },
    fauxAssistantMessage('Done.'),
  ]);
  await corral.open('/');
  await newConversation(page);
  const sessionId = new URL(page.url()).pathname.split('/')[2] as string;
  await earlier(page, sessionId, 24);
  await page.reload();
  await expect(page.locator('[data-chat-item]').first()).toBeVisible();
  await requestBox(page).fill('Ask me how to report it.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await asked.reached;
  await waitForStill(page);
  const timeline = page.getByTestId('chat-timeline');
  await timeline.hover({ position: { x: 16, y: 200 } });
  for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, -500);
  await waitForStill(page);
  asked.open();
  const form = tray(page).getByRole('form', { name: 'Waiting for you' });
  await expect(form).toHaveCount(1, { timeout: 30_000 });
  await expect(tray(page)).not.toBeInViewport();
  // Out of view: the composer's activity bar says what waits.
  const notice = waitingLine(page);
  await expect(notice).toContainText('Which format should I use?');
  await notice.getByRole('button', { name: 'View', exact: true }).click();
  await expect(tray(page)).toBeFocused();
  await expect(tray(page)).toBeInViewport();
  // In view, the card says it; the notice does not say it again.
  await expect(notice).toHaveCount(0);
  await form.getByRole('textbox', { name: 'Your answer' }).fill('A table');
  await form.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('chat-result')).toContainText('Done.', { timeout: 30_000 });
  expect(corral.errors).toEqual([]);
});

type Box = { top: number; bottom: number; left: number; right: number };

type ComposerFrame = {
  notice: boolean;
  height: number | null;
  /** The composer's height without its request box, which sizes itself to its own lines. */
  around: number | null;
  tray: boolean;
  /** Where the composer is drawn, and the question card in the tray. */
  composer: Box | null;
  question: Box | null;
  view: { width: number; height: number };
};

/**
 * Every frame from now on: whether the composer tells of a wait, the composer's height (whole,
 * and around its request box), whether the tray is there, and where the composer and the
 * question stand in the viewport.
 */
const sampleComposer = () => {
  const frames: ComposerFrame[] = [];
  (window as unknown as { composerFrames: ComposerFrame[] }).composerFrames = frames;
  const boxOf = (element: Element) => {
    const { top, bottom, left, right } = element.getBoundingClientRect();
    return { top, bottom, left, right };
  };
  const sample = () => {
    // Only while it is drawn: a conversation the panel is maximized over keeps its layout, hidden.
    const composer = document.querySelector('[data-testid="chat-composer"]');
    const drawn = composer?.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const height = composer && drawn ? composer.getBoundingClientRect().height : null;
    const box = composer?.querySelector('textarea')?.getBoundingClientRect().height ?? 0;
    const question = document.querySelector('[data-pending-tray] [data-question]');
    frames.push({
      notice: Boolean(document.querySelector('[data-testid="activity-bar"][data-line="waiting"]')),
      height,
      around: height ? height - box : null,
      tray: Boolean(document.querySelector('[data-pending-tray]')),
      composer: composer && drawn ? boxOf(composer) : null,
      question: question && drawn ? boxOf(question) : null,
      view: { width: window.innerWidth, height: window.innerHeight },
    });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

/**
 * The frames whose composer, while drawn, reaches past the viewport's edge or covers part of the
 * question; overlaps within subpixel rounding are left out.
 */
const misplaced = (frames: ComposerFrame[]) =>
  frames.flatMap((frame, index) => {
    const { composer, question, view } = frame;
    if (!composer) return [];
    const outside =
      composer.top < -0.5 ||
      composer.left < -0.5 ||
      composer.bottom > view.height + 0.5 ||
      composer.right > view.width + 0.5;
    const covers =
      question !== null &&
      Math.min(composer.bottom, question.bottom) - Math.max(composer.top, question.top) > 0.5 &&
      Math.min(composer.right, question.right) - Math.max(composer.left, question.left) > 0.5;
    return outside || covers ? [{ index, composer, question, view }] : [];
  });

const composerFrames = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { composerFrames: ComposerFrame[] }).composerFrames.slice(),
  );

test('a question arriving at the followed end, or there on load, brings no notice and keeps the composer still', async ({
  page,
  corral,
}) => {
  test.setTimeout(150_000);
  const asked = hold();
  corral.fake?.setResponses([
    async () => {
      asked.reach();
      await asked.opened;
      return question();
    },
    fauxAssistantMessage('Done.'),
  ]);
  await corral.open('/');
  await newConversation(page);
  const sessionId = new URL(page.url()).pathname.split('/')[2] as string;
  await earlier(page, sessionId, 24);
  await page.reload();
  await expect(page.locator('[data-chat-item]').first()).toBeVisible();
  await requestBox(page).fill('Ask me how to report it.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await asked.reached;
  await waitForStill(page);
  // Following the end of a conversation taller than its view.
  const timeline = page.getByTestId('chat-timeline');
  expect(await timeline.evaluate((box) => box.scrollHeight > box.clientHeight * 2)).toBe(true);
  const form = tray(page).getByRole('form', { name: 'Waiting for you' });

  // The question arrives at the end being followed: sampled every frame from before it comes.
  await page.evaluate(sampleComposer);
  asked.open();
  await expect(form).toBeVisible({ timeout: 30_000 });
  await waitForStill(page);
  await expect(tray(page)).toBeInViewport();
  const arriving = await composerFrames(page);
  expect(arriving.filter((frame) => frame.tray).length).toBeGreaterThan(10);
  expect(arriving.filter((frame) => frame.notice)).toEqual([]);
  expect(new Set(arriving.map((frame) => frame.height)).size).toBe(1);

  // A fresh load with the question waiting, sampled from the first frame: the composer's own
  // lines settle as the run loads, but from the tray's first frame on its height holds, and it
  // never grows past where it settles (a notice shown and withdrawn would).
  await page.addInitScript(sampleComposer);
  await page.reload();
  await expect(form).toBeVisible({ timeout: 30_000 });
  await waitForStill(page);
  await expect(tray(page)).toBeInViewport();
  const loading = await composerFrames(page);
  const withTray = loading.slice(loading.findIndex((frame) => frame.tray));
  expect(withTray.filter((frame) => frame.tray).length).toBeGreaterThan(10);
  expect(loading.filter((frame) => frame.notice)).toEqual([]);
  expect(new Set(withTray.map((frame) => frame.height)).size).toBe(1);
  const settled = withTray.at(-1)?.height ?? 0;
  expect(Math.max(...loading.map((frame) => frame.height ?? 0))).toBe(settled);
  await expect(waitingLine(page)).toHaveCount(0);

  await form.getByRole('textbox', { name: 'Your answer' }).fill('A table');
  await form.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('chat-result')).toContainText('Done.', { timeout: 30_000 });
  expect(corral.errors).toEqual([]);
});

test('coming back to a conversation whose question is in view brings no notice and keeps the composer still', async ({
  page,
  corral,
}) => {
  test.setTimeout(150_000);
  corral.fake?.setResponses([question(), fauxAssistantMessage('Done.')]);
  const { cleanup } = await conversationWithWorkingCopy(page, corral);
  try {
    await requestBox(page).fill('Ask me how to report it.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const form = tray(page).getByRole('form', { name: 'Waiting for you' });
    await expect(form).toBeVisible({ timeout: 30_000 });
    await waitForStill(page);
    await expect(tray(page)).toBeInViewport();
    const composer = page.getByTestId('chat-composer');
    /** The composer's size as it stands: width, height, and height around its request box. */
    const composerSize = () =>
      composer.evaluate((element) => {
        const { width, height } = element.getBoundingClientRect();
        const box = element.querySelector('textarea')?.getBoundingClientRect().height ?? 0;
        return { width, height, around: height - box };
      });
    const alone = await composerSize();

    /**
     * The panel opened from "+" (beside the conversation, or a tab added to it), maximized over
     * the conversation, and back, every frame sampled from before the open. Opening beside
     * narrows the composer, a layout of its own: through it no waiting line shows, the composer
     * grows no taller than the larger of where it stood and where it settles beside, and it stays
     * in the viewport, clear of the question. Back, the composer comes as it settles there: back
     * to the conversation alone, that is where it was at first; back beside the panel, the size
     * it had beside before it was maximized.
     */
    const roundTrip = async (
      name: string,
      item: 'Runs' | 'Files',
      back: () => Promise<void>,
      returns: 'alone' | 'beside the panel',
    ) => {
      const before = await composerSize();
      const startsAlone = !(await sessionPanel(page).isVisible());
      await page.evaluate(sampleComposer);
      await openPanelTab(page, item);
      // Beside the conversation: the panel on screen, and the composer with it, narrower when the
      // conversation had the work area to itself.
      await expect(sessionPanel(page)).toBeVisible();
      await expect(composer).toBeVisible();
      await waitForStill(page);
      const beside = await composerSize();
      if (startsAlone)
        expect(beside.width, `${name}: composer narrower beside`).toBeLessThan(before.width - 1);
      await maximizePanel(page);
      await expect(composer).toBeHidden();
      await waitForStill(page, { stillMs: 600 }).catch(() => undefined);
      const leaving = (await composerFrames(page)).length;
      await back();
      await expect(form).toBeVisible();
      await waitForStill(page);
      await expect(tray(page)).toBeInViewport();
      const after = await composerSize();
      const frames = await composerFrames(page);
      const going = frames.slice(0, leaving);
      const returning = frames.slice(leaving);
      // The open beside was sampled: frames drawn at the composer's width beside the panel.
      expect(
        going.filter(
          (frame) =>
            frame.composer &&
            Math.abs(frame.composer.right - frame.composer.left - beside.width) < 1,
        ).length,
        `${name}: frames drawn beside`,
      ).toBeGreaterThan(10);
      expect(returning.length, `${name}: frames back`).toBeGreaterThan(10);
      expect(
        frames.filter((frame) => frame.notice),
        `${name}: notice`,
      ).toEqual([]);
      expect(
        misplaced(going),
        `${name}: composer leaving, off screen or over the question`,
      ).toEqual([]);
      expect(
        misplaced(returning),
        `${name}: composer back, off screen or over the question`,
      ).toEqual([]);
      // Leaving: the composer never taller than the larger of where it stood and where it settled.
      expect(
        Math.max(...going.map((frame) => frame.height ?? 0)),
        `${name}: composer height leaving`,
      ).toBeLessThanOrEqual(Math.max(before.height, beside.height));
      // Back: the composer around its request box keeps the one height it settled at (the request
      // box sizes itself again to its lines when shown, which is the box's own doing), and the
      // whole composer never grows past where it settled.
      expect(
        [...new Set(returning.flatMap((frame) => (frame.around ? [frame.around] : [])))],
        `${name}: composer around its request box back`,
      ).toEqual([after.around]);
      expect(
        Math.max(...returning.map((frame) => frame.height ?? 0)),
        `${name}: composer height back`,
      ).toBe(after.height);
      if (returns === 'alone')
        expect([after.height, after.around], `${name}: settled alone`).toEqual([
          alone.height,
          alone.around,
        ]);
      else {
        // Beside again: the size it had beside before the trip, but for subpixel rounding.
        expect(Math.abs(after.width - beside.width), `${name}: width beside`).toBeLessThan(1);
        expect(Math.abs(after.height - beside.height), `${name}: height beside`).toBeLessThan(1);
      }
      await expect(waitingLine(page)).toHaveCount(0);
    };

    // The run record in front (its tab maximized over the conversation), then back by closing
    // the panel.
    await roundTrip('record, by the toggle', 'Runs', () => closePanel(page), 'alone');
    // The run record in front, then back by its response area's Respond, which restores the
    // panel beside the conversation.
    const respond = page.getByTestId('run-monitor').getByTestId('respond-in-conversation');
    await roundTrip(
      'record, by Respond',
      'Runs',
      async () => {
        await expect(respond).toBeVisible();
        await respond.click();
        await expect(tray(page)).toBeFocused();
      },
      'beside the panel',
    );
    // The files added beside the run record and in front, then back by closing the panel.
    await roundTrip('files, by the toggle', 'Files', () => closePanel(page), 'alone');

    await form.getByRole('textbox', { name: 'Your answer' }).fill('A table');
    await form.getByRole('button', { name: 'Send answer' }).click();
    await expect(page.getByTestId('chat-result')).toContainText('Done.', { timeout: 30_000 });
    expect(corral.errors).toEqual([]);
  } finally {
    await cleanup();
  }
});
