import { expect, test } from '@playwright/test';

// Roadmap 16: two runs of a Corral side by side, picked from the workspace's run list.

test('[TC-OBS-004-H] compares two runs: figures, models and the outputs with their differences', async ({
  page,
}) => {
  await page.goto('/?delay=50');
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Edit this team' })
    .click();
  await expect(page).toHaveURL(/\/edit$/);
  for (const brief of ['Compare two pens.', 'Compare three pens.']) {
    await page.getByLabel('Run brief').fill(brief);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  }
  // In-app navigation (in the browser runtime, runs last until a reload), after saving the
  // edited brief so the editor lets the page go.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
  await page.getByRole('tab', { name: /^Runs/ }).click();
  const runs = page.getByRole('region', { name: 'Runs' });
  await runs.getByRole('checkbox').nth(0).check();
  await runs.getByRole('checkbox').nth(1).check();
  await runs.getByRole('button', { name: 'Compare 2 runs' }).click();

  await expect(page).toHaveURL(/\/compare\?/);
  const table = page.getByRole('table', { name: 'Run figures' });
  await expect(table.getByRole('row', { name: /Model calls/ })).toBeVisible();
  const outputs = page.getByRole('region', { name: 'Outputs' });
  await expect(outputs).toContainText('Compare two pens.');
  await expect(outputs).toContainText('Compare three pens.');
  await outputs.getByRole('button', { name: 'Show differences' }).click();
  await expect(outputs.locator('[data-diff="added"]').first()).toBeVisible();
});
