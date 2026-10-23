import { expect, test } from '@playwright/test';

test('[TC-ABS-007-H] shortcuts edit, persist, dispatch, reset and keep Search reachable', async ({
  page,
}) => {
  // Settings open as the dialog over work (#88); app shortcuts act once it is closed.
  const settings = page.locator('[data-settings-dialog]');
  const palette = page.locator('[role="dialog"]:not([data-settings-dialog])');
  const openShortcuts = async () => {
    await page.goto('/settings?section=shortcuts');
    await expect(settings).toBeVisible();
  };
  const closeSettings = async () => {
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(settings).toHaveCount(0);
  };
  const edit = page.getByRole('button', {
    name: 'Change shortcut for Command palette',
    exact: true,
  });
  await openShortcuts();
  await edit.click();
  await edit.press('Control+Shift+k');
  await expect(edit).toHaveText('Ctrl+Shift+K');
  await closeSettings();
  await page.keyboard.press('Control+k');
  await expect(palette).toHaveCount(0);
  await page.keyboard.press('Control+Shift+k');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await openShortcuts();
  await expect(edit).toHaveText('Ctrl+Shift+K');
  await closeSettings();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await openShortcuts();
  await page.getByRole('button', { name: 'Reset shortcuts', exact: true }).click();
  await expect(edit).toHaveText('Ctrl+K');
  await closeSettings();
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
});

test('[TC-ABS-007-N] capture rejects conflicts and editing keys, Escape leaves binding unchanged', async ({
  page,
}) => {
  await page.goto('/settings?section=shortcuts');
  const edit = page.getByRole('button', {
    name: 'Change shortcut for Command palette',
    exact: true,
  });
  await edit.click();
  await edit.press('Control+b');
  await expect(page.getByRole('alert')).toContainText('Another command');
  await edit.press('Control+v');
  await expect(page.getByRole('alert')).toContainText('reserved');
  await edit.press('Escape');
  await expect(edit).toHaveText('Ctrl+K');
  // Escape ends the capture only: settings stay open and no palette opens.
  await expect(page.locator('[data-settings-dialog]')).toBeVisible();
  await expect(page.locator('[role="dialog"]:not([data-settings-dialog])')).toHaveCount(0);
});
