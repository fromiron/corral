import { expect, type Locator, type Page, test } from '@playwright/test';
import { requestBox, teamFromTemplate } from './workbench.ts';

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
