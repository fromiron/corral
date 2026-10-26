import { expect, test } from '@playwright/test';

// a new Run that starts from an earlier result; the new Run says where it came from.

test('a finished result starts the next run, which names its source', async ({ page }) => {
  await page.goto('/demo?template=starter&delay=100');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  const firstRun = page.url();
  await page.getByRole('button', { name: 'New run from this result' }).click();
  const banner = page.getByTestId('start-from');
  await expect(banner).toContainText('The next run starts from');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await expect(banner).toHaveCount(0);
  await page.getByRole('link', { name: 'Open execution page' }).click();
  const summary = page.getByRole('region', { name: 'Execution summary' });
  await expect(summary).toContainText('Started from');
  await expect(summary.getByRole('link', { name: /of run run_/ })).toBeVisible();
  expect(page.url()).not.toBe(firstRun);
});
