import { expect, test } from '@playwright/test';

// Command palette, shortcut help and the workspace template gallery (roadmap UX-A5).

test('Ctrl+K opens the command palette; typing filters and Enter runs the command', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /^Sessions/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  const input = palette.getByRole('combobox', { name: 'Search commands' });
  await expect(input).toBeFocused();
  await input.fill('research team');
  await expect(palette.getByRole('option').first()).toHaveText(/Research team/);
  await input.press('Enter');
  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit$/);
  await expect(page.getByLabel('Team name')).toHaveValue('Research team');
  await expect(page.locator('.react-flow__node')).toHaveCount(9);
});

test('the palette closes with Escape, and an IME composition Enter does not run a command', async ({
  page,
}) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Start chat', exact: true });
  await opener.focus();
  // `/` opens the current project; the page must stay exactly where it is.
  const before = page.url();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const input = palette.getByRole('combobox', { name: 'Search commands' });
  await input.fill('새 코럴');
  await input.dispatchEvent('keydown', {
    key: 'Enter',
    isComposing: true,
    keyCode: 229,
    bubbles: true,
  });
  await expect(page).toHaveURL(before);
  await expect(palette).toBeVisible();
  await input.press('Escape');
  await expect(palette).toBeHidden();
  await expect(opener).toBeFocused();
});
