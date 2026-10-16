import { expect, test } from '@playwright/test';

// A team drafted from a goal (CR-006): the local suggestion, edited, then opened in the editor.

test('[TC-UX-003-H] drafts a team from a goal, takes an edit, and opens it in the editor', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Draft from a goal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Draft a team from a goal' });
  await dialog
    .getByLabel('What should the team do?')
    .fill('Compare SQLite and PostgreSQL for an internal tool');
  await dialog.getByRole('button', { name: 'Suggest a team' }).click();
  await expect(dialog.getByText('Research, then write and review')).toBeVisible();
  await expect(dialog.getByLabel('Team name')).toHaveValue(
    'Compare SQLite and PostgreSQL for an internal tool',
  );
  await dialog.getByLabel('Name of role 2').fill('Author');
  await dialog.getByLabel('Rounds of review').selectOption('3');
  await dialog.getByRole('button', { name: 'Open in editor' }).click();

  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit$/);
  await expect(page.getByLabel('Corral name')).toHaveValue(
    'Compare SQLite and PostgreSQL for an internal tool',
  );
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  await expect(page.locator('.react-flow__node', { hasText: 'Author' })).toHaveCount(1);
  await expect(page.getByText('Ready to run.')).toBeVisible();
});

test('[TC-UX-003-N] an empty goal cannot be drafted, and cancelling saves nothing', async ({
  page,
}) => {
  await page.goto('/?draft=1');
  const dialog = page.getByRole('dialog', { name: 'Draft a team from a goal' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Suggest a team' })).toBeDisabled();
  await dialog.getByLabel('What should the team do?').fill('Translate this paragraph');
  await dialog.getByRole('button', { name: 'Suggest a team' }).click();
  await expect(dialog.getByText('One agent')).toBeVisible();
  // An emptied role name is refused before anything is saved.
  await dialog.getByLabel('Name of role 1').fill('');
  await expect(dialog.getByRole('button', { name: 'Open in editor' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('No Corrals yet')).toBeVisible();
});
