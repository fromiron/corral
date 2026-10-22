import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { requestBox, startSession, teamFromTemplate } from './workbench.ts';

// Layout regressions from the workbench audit (#93–#95): a control that is in the DOM but
// clipped by a scroller or replaced by another pane still fails a person.

async function blankSession(page: Page) {
  await page.goto('/?delay=50');
  await teamFromTemplate(page);
  await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
}

/** The element is painted where a pointer would reach it, not clipped by an ancestor. */
async function expectReachable(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const hit = await target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const top = document.elementFromPoint(x, y);
    return top !== null && (top === node || node.contains(top));
  });
  expect(hit).toBe(true);
}

test('#93 the / command menu shows every row above a short composer scroller', async ({ page }) => {
  await blankSession(page);
  const box = requestBox(page);
  await box.fill('/');
  const menu = page.getByRole('listbox', { name: 'Commands' });
  await expect(menu).toBeVisible();
  const options = menu.getByRole('option');
  await expect(options).not.toHaveCount(0);
  await expectReachable(options.first());
  await expectReachable(options.last());
  // Keyboard choice still reaches the last row and the input keeps focus.
  const count = await options.count();
  for (let i = 1; i < count; i++) await box.press('ArrowDown');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await expect(box).toBeFocused();
  await box.press('Escape');
  await expect(menu).toBeHidden();
});

test('#93 the @ reference menu is not clipped by the composer scroller', async ({ page }) => {
  await blankSession(page);
  const box = requestBox(page);
  await box.fill('@');
  const menu = page.getByRole('listbox', { name: 'References' });
  await expect(menu).toBeVisible();
  const options = menu.getByRole('option');
  if ((await options.count()) > 0) {
    await expectReachable(options.first());
    await expectReachable(options.last());
  } else await expectReachable(menu);
});

test('#95 every pane tab is selected by a click on it and none closes', async ({ page }) => {
  await blankSession(page);
  const tabs = page.locator('[data-tab-panel-id]');
  const before = await tabs.evaluateAll((list) =>
    list.map((node) => node.getAttribute('data-tab-panel-id')),
  );
  for (const name of ['Git', 'Changes', 'Run', 'Results', 'Files', 'Terminal', 'Checks']) {
    const tab = page.getByRole('tab', { name, exact: true });
    await tab.hover();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
  await expect(tabs).toHaveCount(before.length);
});

test('#95 an untrusted folder offers its trust settings, and a linked folder drops the link hint', async ({
  page,
}) => {
  await blankSession(page);
  const empty = page.getByTestId('chat-timeline');
  await expect(empty.getByRole('button', { name: 'Work folder', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Folders & tools', exact: true }).click();
  await page.getByRole('button', { name: 'Link the example folder', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(
    empty.getByText('Ask a question or describe a task.', { exact: true }),
  ).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Work folder', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.getByText("Trust the project's repository first.")).toBeVisible();
  await page.getByRole('link', { name: 'Open trust settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('checkbox', { name: 'Trust this repository' })).toBeVisible();
});

test('#94 at 390px a session opens on the conversation and other panes open and close over it', async ({
  page,
}) => {
  await blankSession(page);
  const url = page.url().split('?')[0] as string;
  // A remembered side pane (here: Run) must not replace the conversation on a phone.
  await page.goto(`${url}?panel=run`);
  await expect(page.getByRole('tab', { name: 'Run', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await expectReachable(requestBox(page));
  const toolbar = page.getByTestId('dock-toolbar');
  expect((await toolbar.boundingBox())?.height ?? 0).toBeLessThanOrEqual(52);
  // Another pane opens from the one switcher, then closes back to the conversation.
  const panes = toolbar.getByRole('combobox', { name: 'Panes', exact: true });
  await panes.click();
  await page.getByRole('option', { name: 'Files', exact: true }).click();
  await expect(page.getByText('Link a work folder to browse files.')).toBeVisible();
  await expect(requestBox(page)).toBeHidden();
  await toolbar.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await expectReachable(requestBox(page));
});

test('[TC-WIDGET-001-H] at 390px opening another pane and coming back keeps the same draft box', async ({
  page,
}) => {
  // The narrow dock replaced WorkbenchLayout's side panel (#90); the draft must survive it.
  await blankSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await requestBox(page).fill('Preserved draft');
  await requestBox(page).evaluate((node) => {
    (node as HTMLElement & { marked?: boolean }).marked = true;
  });
  const toolbar = page.getByTestId('dock-toolbar');
  await toolbar.getByRole('combobox', { name: 'Panes', exact: true }).click();
  await page.getByRole('option', { name: 'Files', exact: true }).click();
  await expect(requestBox(page)).toBeHidden();
  await toolbar.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await expect(requestBox(page)).toHaveValue('Preserved draft');
  expect(
    await requestBox(page).evaluate((node) => (node as HTMLElement & { marked?: boolean }).marked),
  ).toBe(true);
});

test('#94 shrinking an open session to 390px keeps the conversation reachable', async ({
  page,
}) => {
  await blankSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectReachable(requestBox(page));
  const toolbar = page.getByTestId('dock-toolbar');
  await expect(toolbar.getByRole('combobox', { name: 'Panes', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('combobox', { name: 'Layout', exact: true })).toHaveCount(0);
});

test('#70 #86 Git, Terminal and running commands open from the palette, / and the URL', async ({
  page,
}) => {
  await blankSession(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const input = palette.getByRole('combobox', { name: 'Search commands' });
  await input.fill('terminal');
  await expect(palette.getByRole('option').first()).toHaveText(/Open Terminal/);
  await input.press('Enter');
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page).toHaveURL(/panel=terminal/);
  await requestBox(page).fill('/git');
  await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
  await requestBox(page).press('Enter');
  await expect(page.getByRole('tab', { name: 'Git', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const url = page.url().split('?')[0] as string;
  await page.goto(`${url}?panel=tools`);
  await expect(
    page.getByRole('tab', { name: 'Running commands & preview', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
});

/** Whether a pointer at the element's centre would reach it (a hidden dock group is not painted). */
const painted = (target: Locator) =>
  target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return top !== null && (top === node || node.contains(top));
  });

test('#71 hiding the panel hides the side and bottom panes, and showing brings them back', async ({
  page,
}) => {
  await blankSession(page);
  const banner = page.getByRole('banner');
  const files = page.getByRole('tab', { name: 'Files', exact: true });
  const checks = page.getByRole('tab', { name: 'Checks', exact: true });
  expect(await painted(files)).toBe(true);
  // Panes are on screen, so the toggle offers to hide them.
  const hide = banner.getByRole('button', { name: 'Hide the panel', exact: true });
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await hide.click();
  await expect.poll(() => painted(files)).toBe(false);
  await expect.poll(() => painted(checks)).toBe(false);
  await expectReachable(requestBox(page));
  const show = banner.getByRole('button', { name: 'Show the panel', exact: true });
  await expect(show).toHaveAttribute('aria-pressed', 'false');
  await show.click();
  await expect.poll(() => painted(checks)).toBe(true);
  await expect(banner.getByRole('button', { name: 'Hide the panel', exact: true })).toBeVisible();
  await expectReachable(requestBox(page));
});

test('#72 an older finished run is labelled as the selected run, not the last run', async ({
  page,
}) => {
  await blankSession(page);
  const timeline = page.getByTestId('chat-timeline');
  for (const [index, text] of ['First request', 'Second request'].entries()) {
    await requestBox(page).fill(text);
    await requestBox(page).press('Control+Enter');
    await expect(timeline.getByText('Succeeded')).toHaveCount(index + 1, { timeout: 20_000 });
  }
  await expect(page.getByText('Last run').first()).toBeAttached();
  const picker = page.getByRole('banner').getByRole('combobox', { name: 'Selected run' });
  await picker.click();
  await page.getByRole('option', { name: /First request/ }).click();
  await expect(page.getByText('Selected run · 1 of 2').first()).toBeAttached();
  await expect(page.getByText('Last run')).toHaveCount(0);
});

async function finishedRunPage(page: Page) {
  const timeline = page.getByTestId('chat-timeline');
  await requestBox(page).fill('Summarise the plan');
  await requestBox(page).press('Control+Enter');
  await expect(timeline.getByText('Succeeded')).toBeVisible({ timeout: 20_000 });
  // The demo keeps runs in this page's worker, so the run page is reached in-app.
  await page.locator('a[href*="/runs/run_"]').first().dispatchEvent('click');
  await expect(page).toHaveURL(/\/runs\/run_/);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
}

test('#73 an automatically composed team offers no edit link to a team that was never saved', async ({
  page,
}) => {
  await blankSession(page);
  await finishedRunPage(page);
  await expect(page.getByText('Team composed for this run · not a saved team')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit team', exact: true })).toHaveCount(0);
});

test('#73 a saved team keeps its edit link on the run page', async ({ page }) => {
  await page.goto('/?delay=50');
  await teamFromTemplate(page);
  await startSession(page, 'Saved team run');
  await finishedRunPage(page);
  await page.getByRole('link', { name: 'Edit team', exact: true }).click();
  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit/);
  await expect(page.getByText('not found', { exact: false })).toHaveCount(0);
});

test('#75 a tooltip shortcut is drawn on the tooltip surface, not on a light key fill', async ({
  page,
}) => {
  await blankSession(page);
  await page
    .getByRole('banner')
    .getByRole('button', { name: 'Hide the panel', exact: true })
    .hover();
  const key = page.locator('[data-tone="inverse"]');
  await expect(key).toBeVisible();
  const colours = await key.evaluate((node) => {
    const popup = node.parentElement as HTMLElement;
    return {
      keyBackground: getComputedStyle(node).backgroundColor,
      keyText: getComputedStyle(node).color,
      popupText: getComputedStyle(popup).color,
    };
  });
  expect(colours.keyBackground).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(colours.keyText).toBe(colours.popupText);
});

test('#76 dragging a step across a Loop boundary says it changes the team, and Undo restores it', async ({
  page,
}) => {
  await page.goto('/?delay=50');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  const examples = join(import.meta.dirname, '..', '..', '..', 'examples');
  await page
    .locator('input[type=file]')
    .setInputFiles([
      join(examples, 'research-team.corral.json'),
      join(examples, 'research-team.layout.json'),
    ]);
  await expect(page).toHaveURL(/\/edit$/);
  const write = page.locator('.react-flow__node[data-id="write"]');
  const box = await write.boundingBox();
  if (!box) throw new Error('no node');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Out of the Loop, below it: the preview names the change before the drop.
  await page.mouse.move(box.x + box.width / 2, box.y + 420, { steps: 12 });
  const notice = page.getByTestId('loop-notice');
  await expect(notice).toContainText('stop repeating');
  await page.mouse.up();
  await expect(notice).toContainText('no longer repeats');
  await page.keyboard.press('Control+z');
  await expect(page.getByText('Ready to run.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Arrange graph', exact: true })).toHaveAttribute(
    'title',
    'Moves boxes only; the team does not change',
  );
});

test('#77 request options say what is kept for the conversation and what is for the next request', async ({
  page,
}) => {
  await blankSession(page);
  await page.getByRole('button', { name: 'Request options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Request options', exact: true });
  await expect(options.getByTestId('applies-session')).toHaveText(
    'Saved for this conversation; later requests use it too',
  );
  await expect(options.getByRole('group', { name: 'Scope · Next request only' })).toBeVisible();
  await expect(options.getByRole('group', { name: 'Add to the request' })).toBeVisible();
  await page.screenshot({
    path: `${process.env.SHOTS ?? 'test-results'}/77-options.png`,
  });
});

test('#77 a test run says it starts a separate run outside any conversation', async ({ page }) => {
  await page.goto('/?delay=50');
  await teamFromTemplate(page);
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.getByRole('button', { name: 'Edit this team' }).first().click();
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await expect(page.getByTestId('run-scope')).toContainText('It is not added to a conversation.');
});

test('#81 settings that save as you change them say so', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('settings-save-mode')).toHaveText(
    'Changes on this page apply and save right away.',
  );
});

test('#83 the narrow settings menu keeps the desktop groups and order', async ({ page }) => {
  await blankSession(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const desktop = await dialog
    .getByTestId('settings-sidebar')
    .locator('section')
    .evaluateAll((groups) =>
      groups.map((group) => [
        group.getAttribute('aria-label'),
        [...group.querySelectorAll('a')].map((link) => link.textContent?.trim()),
      ]),
    );
  await page.setViewportSize({ width: 500, height: 757 });
  await dialog.getByRole('combobox', { name: 'Settings', exact: true }).click();
  const narrow = await page
    .locator('[data-slot="select-popup"] [role="group"]')
    .evaluateAll((groups) =>
      groups.map((group) => [
        group.querySelector('[id]')?.textContent?.trim() ?? group.firstElementChild?.textContent,
        [...group.querySelectorAll('[role="option"]')].map((option) => option.textContent?.trim()),
      ]),
    );
  expect(desktop).toHaveLength(3);
  expect(narrow).toEqual(desktop);
});

test('#74 a narrow run that waits for a decision points to where it is answered', async ({
  page,
}) => {
  await page.goto('/?delay=50');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  const examples = join(import.meta.dirname, '..', '..', '..', 'examples');
  await page
    .locator('input[type=file]')
    .setInputFiles([
      join(examples, 'research-team.corral.json'),
      join(examples, 'research-team.layout.json'),
    ]);
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(
    page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await page.setViewportSize({ width: 501, height: 757 });
  const views = page.getByRole('tablist', { name: 'Run view' });
  await expect(views.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
  const waiting = page.getByTestId('decision-waiting');
  await expect(waiting).toContainText('A decision is waiting for you');
  await waiting.getByRole('button', { name: 'Open the response', exact: true }).click();
  await expect(views.getByRole('tab', { name: 'Conversation & Reins' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'Continue with this version' }).first(),
  ).toBeVisible();
  await expect(waiting).toHaveCount(0);
});

test('#84 the desktop shell hears the chosen language, and General says where native options are', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: unknown[][] = [];
    Object.assign(window, {
      __desktopCalls: calls,
      corralDesktop: {
        info: async () => ({
          version: '0.0.0',
          platform: 'linux',
          overlay: false,
          status: 'ready',
          gitAvailable: true,
          workspace: '/tmp/workspace',
          node: '24',
        }),
        window: async () => {},
        pickFolder: async () => null,
        openWorkspace: async () => {},
        shortcuts: async () => {},
        revealWorkspace: async () => {},
        openExternal: async () => {},
        openPreview: async () => {},
        retry: async () => {},
        theme: async () => {},
        notify: async () => false,
        badge: async () => {},
        locale: async (value: string) => {
          calls.push(['locale', value]);
        },
        onCommand: () => () => {},
      },
    });
  });
  await page.goto('/settings');
  await expect(page.getByTestId('desktop-native-options')).toContainText('Background');
  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: '한국어', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __desktopCalls: unknown[][] }).__desktopCalls),
    )
    .toContainEqual(['locale', 'ko']);
  await expect(page.getByTestId('desktop-native-options')).toContainText('백그라운드');
});

test('#90 the dock toolbar shows layout and panes; arranging tools, groups and the save rule are folded', async ({
  page,
}) => {
  await blankSession(page);
  const toolbar = page.getByTestId('dock-toolbar');
  await expect(toolbar.getByRole('combobox', { name: 'Layout', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('combobox', { name: 'Open pane', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('combobox', { name: 'Active pane', exact: true })).toBeHidden();
  await toolbar.getByText('Arrange panes', { exact: true }).click();
  await expect(toolbar.getByRole('combobox', { name: 'Active pane', exact: true })).toBeVisible();
  await expect(toolbar).toContainText('saved for this project in this browser');
  await toolbar.getByRole('combobox', { name: 'Move to group', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Side area', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  // Splitting a non-document pane is refused with its reason.
  const files = page.getByRole('tab', { name: 'Files', exact: true });
  const chat = page.locator('[data-dock-panel-id="context:chat"]');
  const box = await chat.boundingBox();
  if (!box) throw new Error('no chat pane');
  await files.dragTo(chat, { targetPosition: { x: box.width - 8, y: box.height / 2 } });
  await expect(page.getByText('Only documents can be split into a new area.')).toBeVisible();
});
