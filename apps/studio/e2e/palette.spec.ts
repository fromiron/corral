import { expect, test } from '@playwright/test';

// Command palette, shortcut help and the workspace template gallery (roadmap UX-A5).

test('[TC-UX-001-H] Ctrl+K opens the command palette; typing filters and Enter runs the command', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Corrals' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  const input = palette.getByRole('combobox', { name: 'Search commands' });
  await expect(input).toBeFocused();
  await input.fill('research team');
  await expect(palette.getByRole('option').first()).toHaveText(/Research team/);
  await input.press('Enter');
  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit$/);
  await expect(page.getByLabel('Corral name')).toHaveValue('Research team');
  await expect(page.locator('.react-flow__node')).toHaveCount(9);
});

test('[TC-UX-001-N] the palette closes with Escape, and an IME composition Enter does not run a command', async ({
  page,
}) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'New Corral' });
  await opener.focus();
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
  await expect(page).toHaveURL(/\/$/);
  await expect(palette).toBeVisible();
  await input.press('Escape');
  await expect(palette).toBeHidden();
  await expect(opener).toBeFocused();
});

test('[TC-UX-001-H] ? shows the keyboard shortcuts, but not while typing in a field', async ({
  page,
}) => {
  await page.goto('/demo?template=starter');
  await page.getByLabel('Run brief').fill('Is ? a question');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('Command palette');
  await expect(help).toContainText('Undo');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
});

test('[TC-CAN-001-H] an empty workspace offers templates, and a template opens as a new Corral', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('No Corrals yet.')).toBeVisible();
  const gallery = page.getByRole('region', { name: 'Start from a template' });
  await expect(gallery.getByRole('article')).toHaveCount(3);
  await gallery
    .getByRole('article')
    .filter({ hasText: 'Research team' })
    .getByRole('button', { name: 'Use this template' })
    .click();
  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit$/);
  await expect(page.locator('.react-flow__node')).toHaveCount(9);
  await page.goto('/');
  // Using a template twice gives two separate Corrals.
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Research team' })
    .getByRole('button', { name: 'Use this template' })
    .click();
  await page.goto('/');
  await expect(page.getByRole('listitem').filter({ hasText: 'Research team' })).toHaveCount(2);
});
