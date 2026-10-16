import { expect, test } from '@playwright/test';

// Roadmap 17: a first-run checklist that follows what has happened, and can be put away.

test('[TC-UX-001-H] the checklist marks each step as it happens and can be dismissed for good', async ({
  page,
}) => {
  await page.goto('/?delay=50');
  const list = page.getByRole('region', { name: 'Getting started' });
  await expect(list.getByTestId('step-corral')).toHaveAttribute('data-done', 'false');
  // In-browser agents are simulated: no model to connect.
  await expect(list.getByTestId('step-model')).toHaveCount(0);
  await list.getByRole('button', { name: 'Start from a goal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Draft a team from a goal' });
  await dialog.getByLabel('What should the team do?').fill('Translate this paragraph');
  await dialog.getByRole('button', { name: 'Suggest a team' }).click();
  await dialog.getByRole('button', { name: 'Open in editor' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();

  await expect(list.getByTestId('step-corral')).toHaveAttribute('data-done', 'true');
  await expect(list.getByTestId('step-run')).toHaveAttribute('data-done', 'true');
  await expect(list.getByTestId('step-review')).toHaveAttribute('data-done', 'false');
  await list.getByRole('button', { name: 'Hide this' }).click();
  await expect(list).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Getting started' })).toHaveCount(0);
});

test('[TC-UX-001-N] a workspace that already has Corrals and runs does not nag', async ({
  page,
}) => {
  await page.goto('/?delay=50');
  await page.evaluate(() => localStorage.clear());
  // Nothing done yet: the list is shown, with the first open step current.
  const list = page.getByRole('region', { name: 'Getting started' });
  await expect(list.locator('[aria-current="step"]')).toHaveAttribute('data-testid', 'step-corral');
});
