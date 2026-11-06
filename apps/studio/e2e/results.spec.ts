import { expect, test } from '@playwright/test';

// The Results view on the in-browser demo
// team. Demo runs live in the page's worker, so the Run page is reached through the app's link.

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

  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // What it made before it stopped is offered as partial, and opens as the artifact it is.
  const side = page.getByTestId('run-side');
  if (!(await side.isVisible()))
    await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
  const partial = side
    .getByRole('region', { name: 'Results', exact: true })
    .getByRole('button', { name: /Partial results$/ })
    .first();
  await partial.click();
  await expect(side.getByTestId('artifact-viewer')).toBeVisible();
});
