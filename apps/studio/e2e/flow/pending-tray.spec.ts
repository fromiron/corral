import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, type Harness, test } from '../server/harness.ts';
import {
  closeSettings,
  newConversation,
  openFolderSettings,
  panelTab,
  requestBox,
} from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

// Scene ④ (docs/plans/unified-flow.md §4.4): a run waits on an approval and then a question, and
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
  await panelTab(page, 'Files');
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await page
    .getByRole('region', { name: 'Working copy' })
    .getByRole('button', { name: /Make a working copy from/ })
    .click();
  await expect(page.getByRole('link', { name: 'Review changes', exact: true })).toBeVisible();
  await panelTab(page, 'Conversation');
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

    // The run record reads the request and sends the person to the tray to answer it.
    await panelTab(page, 'Runs');
    const respond = page.getByTestId('run-monitor').getByTestId('run-respond');
    await expect(respond).toBeVisible();
    // The record reads it; the hidden conversation keeps the one way to answer it.
    expect(await buttonsNamed(page, 'Allow once')).toBe(1);
    const record = page.getByTestId('run-monitor').locator('[data-approval]');
    await expect(record).toContainText('Tool permission');
    await expect(record.locator('[data-approval-action]')).toHaveCount(0);
    await respond.click();
    await expect(page.getByRole('tab', { name: 'Conversation', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
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
