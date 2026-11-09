import { expect, test } from '@playwright/test';
import { showResults, startTestRun } from './workbench.ts';

// The Results view on the in-browser demo
// team. Demo runs live in the page's worker, so the Run page is reached through the app's link.

test('a cancelled run keeps what it made as a partial result', async ({ page }) => {
  await page.goto('/demo?delay=150');
  await startTestRun(page);
  // The decision waits for a person after the drafts and reviews are written.
  await expect(
    page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Cancel whole run', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm whole run cancellation', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Cancelled', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Open execution page' }).click();

  await expect(page.getByRole('group', { name: 'Run graph', exact: true })).toBeVisible();
  // What it made before it stopped is offered as partial, and opens as the artifact it is.
  const partial = (await showResults(page))
    .getByRole('region', { name: 'Partial results', exact: true })
    .getByRole('button')
    .first();
  await partial.click();
  await expect(page.getByTestId('run-document').getByTestId('artifact-viewer')).toBeVisible();
});
