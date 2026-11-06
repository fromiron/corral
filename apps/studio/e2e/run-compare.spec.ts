import { expect, test } from '@playwright/test';

// Roadmap 16: two runs of a Corral side by side, picked from the workspace's run list.

test('compares runs with readable narrow figures and accessible identities', async ({ page }) => {
  await page.goto('/compare?delay=50');
  await page.getByRole('link', { name: 'Choose two runs', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Runs/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Edit this team' })
    .click();
  await page.getByRole('button', { name: 'Save copy and edit' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  for (const brief of ['Compare two pens.', 'Compare three pens.']) {
    await page.getByRole('tab', { name: 'Design', exact: true }).click();
    await page.getByLabel('Run brief').fill(brief);
    await page.getByRole('tab', { name: 'Test run', exact: true }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  }
  // In-app navigation (in the browser runtime, runs last until a reload), after saving the
  // edited brief so the editor lets the page go.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await page.getByRole('tab', { name: /^Runs/ }).click();
  const runs = page.getByRole('region', { name: 'Runs' });
  await expect(runs.getByRole('link', { name: 'Compare two pens.', exact: true })).toBeVisible();
  await expect(runs.getByRole('link', { name: 'Compare three pens.', exact: true })).toBeVisible();
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

  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await table.boundingBox();
  if (!bounds) throw new Error('Comparison table is not visible');
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  const calls = table.getByRole('row', { name: /Model calls/ });
  await expect(calls.getByRole('cell').first()).toHaveCSS('text-align', 'right');
  await expect(calls.getByRole('cell').first()).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(page.getByRole('heading', { name: 'Compare runs', exact: true })).toHaveCount(1);

  const fullRunId = new URL(page.url()).searchParams.get('a');
  if (!fullRunId) throw new Error('Comparison run is missing');
  const identity = table
    .getByRole('columnheader')
    .filter({ has: page.getByRole('button') })
    .first();
  const disclosure = identity.getByRole('button');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(identity.locator('code')).toHaveText(fullRunId);
  await expect(identity.locator('code')).toBeVisible();
  const expandedBounds = await table.boundingBox();
  if (!expandedBounds) throw new Error('Expanded comparison table is not visible');
  expect(expandedBounds.x + expandedBounds.width).toBeLessThanOrEqual(390);
});
