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
