import { expect, type Page, test } from '@playwright/test';

// The Results view on the in-browser demo
// team. Demo runs live in the page's worker, so the Run page is reached through the app's link.

const results = (page: Page) => page.getByRole('navigation', { name: 'Results' });

test('a cancelled run keeps what it made as a partial result', async ({ page }) => {
  await page.goto('/demo?delay=150');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // The decision waits for a person after the drafts and reviews are written.
  await expect(
    page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Cancel whole run', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm whole run cancellation', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Cancelled', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Open execution page' }).click();

  await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
  await expect(results(page).getByRole('status')).toContainText('partial results');
  const partial = results(page).getByRole('region', { name: 'Partial results' });
  await expect(partial.getByRole('button').first()).toBeVisible();
  await expect(page.getByTestId('result-body')).not.toBeEmpty();
  await expect(page.getByRole('list', { name: 'Result state' })).toContainText('Run: Cancelled');
});
