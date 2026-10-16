import { expect, type Page, test } from '@playwright/test';

// Roadmap 20: whole flows with the keyboard only — no clicks, every control reached with Tab.

/** Presses Tab until the focused element's accessible name matches, like a keyboard user. */
async function tabTo(page: Page, name: RegExp, max = 160) {
  // At the end of the page some browsers move focus out to their own UI instead of wrapping;
  // then go back with Shift+Tab, as a keyboard user would.
  let key = 'Tab';
  let previous = '';
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    const id = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return '';
      el.dataset.tabSeen ??= String(Math.random());
      return el.dataset.tabSeen;
    });
    if (id === previous) key = key === 'Tab' ? 'Shift+Tab' : 'Tab';
    previous = id;
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return '';
      const labelled =
        el.getAttribute('aria-label') ??
        (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null);
      // A field's own text is its value or options, not its name.
      const field = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
      return (labelled ?? (field ? '' : el.textContent) ?? '').trim();
    });
    if (name.test(label)) return;
  }
  throw new Error(`Tab never reached ${name}`);
}

test('[TC-UX-001-H] keyboard only: a Corral from a template, a node moved and deleted, a run approved', async ({
  page,
}) => {
  await page.goto('/?delay=50');
  await expect(page.getByRole('heading', { name: 'Corrals' })).toBeVisible();
  await tabTo(page, /^Use this template$/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/edit$/);
  await expect(page.locator('.react-flow__node')).toHaveCount(9);

  // A node is reached with Tab, selected with Enter, moved with the arrow keys.
  await tabTo(page, /^agent: Writer$/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true }).first()).toHaveValue(
    'Writer',
  );
  const before = await page.locator('.react-flow__node[data-id="write"]').boundingBox();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const after = await page.locator('.react-flow__node[data-id="write"]').boundingBox();
  expect((after?.x ?? 0) - (before?.x ?? 0)).toBeGreaterThan(0);

  // The callable helper is removed with Delete, and undone with the shortcut.
  await tabTo(page, /^agent: Research Helper$/);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__node[data-id="helper"]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.react-flow__node[data-id="helper"]')).toHaveCount(1);
  // One undo brings back the node with its links: the Corral runs again.
  await expect(page.getByText('Ready to run.')).toBeVisible();

  // Run, then answer both decisions from the keyboard.
  await tabTo(page, /^Run$/);
  await page.keyboard.press('Enter');
  for (const decision of ['Your decision', 'Final output']) {
    await expect(
      page.locator('[data-testid^="approval-"]').filter({ hasText: decision }),
    ).toBeVisible({ timeout: 30_000 });
    await tabTo(page, /^Approve$/);
    await page.keyboard.press('Enter');
  }
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 30_000 });

  // Save what was moved, then the Run page's detail tabs move with the arrow keys.
  await page.keyboard.press('Control+s');
  await expect(page.getByText('All changes saved')).toBeVisible();
  await tabTo(page, /^Open run page$/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/runs\//);
  await tabTo(page, /^Output$/);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Tasks' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
});
