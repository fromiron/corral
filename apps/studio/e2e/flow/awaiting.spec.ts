import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, type Harness, test } from '../server/harness.ts';
import {
  activityBar,
  activityLine,
  closeSettings,
  earlierRequests,
  newConversation,
  openFolderSettings,
  panelTab,
  requestBox,
} from '../workbench.ts';
import { waitForStill } from './probe.ts';
import {
  checkChrome,
  checkLabels,
  hold,
  measure,
  msg,
  note,
  nothingWaiting,
  shot,
} from './scene.ts';

// Scene ④ waiting on the person (docs/plans/unified-flow.md §9; features/composer-flow.md "지금
// 필요한 것", "활동 바"), in the dark theme. A working run asks to run a command: the approval
// arrives at the timeline's end, once on screen, and Enter decides nothing. Read from above with
// the card off screen, the activity bar says it and approves it, and the run works on. Then it
// asks a question, which arrives while the person still reads above; the bar takes the person to
// it, the answer goes, and the run works on to its end. A draft typed before the approval is in
// the request box all along. No item or session row already on screen moves, the input line does
// not move, and no target's state name is on screen twice.
// Held responses as in pending-tray.spec.ts; the working copy and the trusted folder as there.

const SCENE = 'awaiting';
const DRAFT = 'A draft kept while the run waits';

/** A conversation in a linked, trusted Git folder with its working copy, so a command asks. */
async function commandSession(page: Page, corral: Harness) {
  const original = mkdtempSync(join(tmpdir(), 'corral-awaiting-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('init', '-q');
  writeFileSync(join(original, 'README.md'), '# Awaiting\n');
  git('add', '.');
  git('commit', '-q', '-m', 'source');
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
  // Requests that never ran, so the conversation is taller than its view.
  await earlierRequests(page, sessionId, 20);
  await page.reload();
  await expect(page.locator('[data-chat-item]').first()).toBeVisible();
  return () => rm(original, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

/** Visible buttons with exactly this name: what the screen offers to press. */
const shownButtons = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).filter({ visible: true });

test.use({ live: true, codexLogin: true });

test('④ an approval and a question: at the end once, decided from the bar while reading above, never by Enter', async ({
  page,
  corral,
}) => {
  test.setTimeout(240_000);
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
      return tool('ask_user', {
        key: 'format',
        questions: [{ id: 'format', kind: 'text', prompt: 'Which format should I use?' }],
      });
    },
    (context) => {
      afterAnswer = JSON.stringify(context.messages);
      return fauxAssistantMessage('Done, as a table.');
    },
    fauxAssistantMessage('Done.'),
  ]);
  const runs = () => [...corral.server.coordinator.listRuns()];
  const pending = () => {
    const run = runs()[0];
    return run
      ? Object.values(corral.server.coordinator.getSnapshot(run.runId).projection.approvals).filter(
          (approval) => approval.status === 'pending',
        ).length
      : -1;
  };

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const cleanup = await commandSession(page, corral);
  try {
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(true);
    const box = requestBox(page);
    const tray = page.locator('[data-pending-tray]');
    const card = tray.locator('[data-testid^="approval-"]');
    const bar = activityBar(page);
    const allow = msg('Approvals.approveTool');

    // Working: the run's first response is held. A draft waits in the request box.
    await box.fill('Check the folder, then ask me how to report it.');
    await box.press('Enter');
    await asked.reached;
    await expect(box).toHaveValue('');
    await box.pressSequentially(DRAFT);
    await waitForStill(page);
    await checkLabels(page, SCENE, 'working');

    // The approval arrives at the end, and is on screen once.
    await measure(page, SCENE, 'approval-arrives', async () => {
      asked.open();
      await expect(card).toBeVisible({ timeout: 30_000 });
    });
    await expect(tray).toHaveCount(1);
    await expect(shownButtons(page, allow)).toHaveCount(1);
    await expect(bar).not.toHaveAttribute('data-line', 'waiting');
    note(SCENE, 'approval on screen', { allowButtons: await shownButtons(page, allow).count() });

    // Enter decides nothing: on the tray, or on the bar's toggle (which opens and closes).
    await tray.focus();
    await page.keyboard.press('Enter');
    const toggle = bar.locator('[data-activity-toggle]');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(pending()).toBe(1);
    await expect(card).toBeVisible();
    await expect(box).toHaveValue(DRAFT);

    // Read from above: the card leaves the screen and the bar says it, with its buttons.
    const timeline = page.getByTestId('chat-timeline');
    await timeline.hover({ position: { x: 16, y: 200 } });
    for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, -500);
    await waitForStill(page);
    await expect(tray).not.toBeInViewport();
    await expect(bar).toHaveAttribute('data-line', 'waiting');
    const approve = activityLine(page).getByRole('button', { name: new RegExp(`^${allow}`) });
    // On screen once: the bar's, the card's out of view.
    await expect(approve).toBeInViewport();
    await expect(card.getByRole('button', { name: allow, exact: true })).not.toBeInViewport();
    await checkLabels(page, SCENE, 'card off screen');
    await shot(page, SCENE, 'card-off-screen');

    // Approved from the bar by the keyboard: the reader's rows stay, the run works on.
    await approve.focus();
    await measure(
      page,
      SCENE,
      'approved-from-bar',
      async () => {
        await page.keyboard.press('Enter');
        await questioned.reached;
        await expect.poll(pending).toBe(0);
        await expect(card).toHaveCount(0);
      },
      { at: 'above' },
    );
    expect(afterCommand).toContain('tray-ok');
    await expect(box).toHaveValue(DRAFT);

    // The question arrives while the person still reads above; the reader's rows stay.
    const form = tray.getByRole('form', { name: msg('Harness.userQuestions') });
    await measure(
      page,
      SCENE,
      'question-arrives',
      async () => {
        questioned.open();
        await expect(form).toHaveCount(1, { timeout: 30_000 });
        await expect(bar).toHaveAttribute('data-line', 'waiting');
      },
      { at: 'above' },
    );
    await expect(tray).not.toBeInViewport();
    await expect(activityLine(page)).toContainText('Which format should I use?');

    // The bar's View takes the person to it; answered, the run works on to its end.
    await activityLine(page)
      .getByRole('button', { name: msg('Activity.view'), exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await expect(tray).toBeInViewport();
    await expect(page.getByRole('form', { name: msg('Harness.userQuestions') })).toHaveCount(1);
    await waitForStill(page);
    await checkLabels(page, SCENE, 'question in view');
    await form.getByRole('textbox', { name: msg('Harness.yourAnswer') }).fill('A table');
    await waitForStill(page);
    await measure(page, SCENE, 'question-answered', async () => {
      await form.getByRole('textbox', { name: msg('Harness.yourAnswer') }).focus();
      await page.keyboard.press('Tab');
      await expect(
        form.getByRole('button', { name: msg('Harness.sendAnswer'), exact: true }),
      ).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('chat-result')).toContainText('Done, as a table.', {
        timeout: 30_000,
      });
      await expect.poll(() => runs()[0]?.status, { timeout: 30_000 }).toBe('succeeded');
      await expect(tray).toHaveCount(0);
    });
    expect(afterAnswer).toContain('A table');

    // The draft is where it was typed.
    await expect(box).toHaveValue(DRAFT);
    await checkLabels(page, SCENE, 'end');
    await checkChrome(page, SCENE, 'end');
    await shot(page, SCENE, 'end');
    nothingWaiting(corral.server.coordinator, SCENE);
    expect(corral.errors).toEqual([]);
  } finally {
    await cleanup();
  }
});
