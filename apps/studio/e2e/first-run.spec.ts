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

test('[TC-UX-001-N] opening a missing run does not mark its result as read', async ({ page }) => {
  await page.goto('/runs/run_missing');
  await expect(page.getByText('This run is not available here.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
  await expect(page.getByTestId('step-review')).toHaveAttribute('data-done', 'false');
});

test('[TC-UX-001-H] the result step waits for a result on the run page', async ({ page }) => {
  await page.goto('/?delay=1500');
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Use this template' })
    .click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Pause run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Paused');
  await page.getByRole('link', { name: 'Open run page' }).click();
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
  await expect(page.getByTestId('step-review')).toHaveAttribute('data-done', 'false');

  await page.getByRole('tab', { name: /^Runs/ }).click();
  await page.getByRole('region', { name: 'Runs' }).getByRole('link').click();
  await page.getByRole('button', { name: 'Resume run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Getting started' })).toHaveCount(0);
});
