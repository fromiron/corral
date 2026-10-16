import { expect, test } from '@playwright/test';

// CR-007: a new Run that starts from an earlier result; the new Run says where it came from.

test('[TC-ART-005-H] a finished result starts the next run, which names its source', async ({
  page,
}) => {
  await page.goto('/demo?template=starter&delay=100');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  const firstRun = page.url();
  await page.getByRole('button', { name: 'New run from this result' }).click();
  const banner = page.getByTestId('start-from');
  await expect(banner).toContainText('The next run starts from');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await expect(banner).toHaveCount(0);
  await page.getByRole('link', { name: 'Open run page' }).click();
  const summary = page.getByRole('region', { name: 'Run summary' });
  await expect(summary).toContainText('Started from');
  await expect(summary.getByRole('link', { name: /of run run_/ })).toBeVisible();
  expect(page.url()).not.toBe(firstRun);
});

test('[TC-ART-005-N] the starting point can be cleared before the run', async ({ page }) => {
  await page.goto('/demo?template=starter&delay=100');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await page.getByRole('button', { name: 'New run from this result' }).click();
  await page.getByTestId('start-from').getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByTestId('start-from')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await page.getByRole('link', { name: 'Open run page' }).click();
  await expect(page.getByRole('region', { name: 'Run summary' })).not.toContainText('Started from');
});
