import { expect, test } from '@playwright/test';

test('[TC-ABS-007-H] shortcuts edit, persist, dispatch, reset and keep Search reachable', async ({
  page,
}) => {
  await page.goto('/settings?section=shortcuts');
  const edit = page.getByRole('button', {
    name: 'Change shortcut for Command palette',
    exact: true,
  });
  await edit.click();
  await edit.press('Control+Shift+k');
  await expect(edit).toHaveText('Ctrl+Shift+K');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(edit).toHaveText('Ctrl+Shift+K');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Reset shortcuts', exact: true }).click();
  await expect(edit).toHaveText('Ctrl+K');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
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
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
