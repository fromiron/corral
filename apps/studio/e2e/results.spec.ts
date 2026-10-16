import { expect, type Page, test } from '@playwright/test';

// The Results view (CR-009, roadmap 21; proposal WBTST-008/009/027) on the in-browser demo
// team. Demo runs live in the page's worker, so the Run page is reached through the app's link.

const approve = async (page: Page, kind: 'Your decision' | 'Final output') => {
  const card = page.locator('[data-testid^="approval-"]').filter({ hasText: kind });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Approve' }).click();
};

const results = (page: Page) => page.getByRole('navigation', { name: 'Results' });

test('[WBTST-008] a finished run opens on its results, and every version can be read', async ({
  page,
}) => {
  await page.goto('/demo?delay=150');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await approve(page, 'Your decision');
  await approve(page, 'Final output');
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await page.getByRole('link', { name: 'Open run page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_/);

  await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
  const final = results(page).getByRole('region', { name: 'Final results' });
  await expect(final.getByRole('button')).toHaveCount(1);
  await expect(final.getByRole('button')).toHaveAttribute('aria-current', 'true');
  const body = page.getByTestId('result-body');
  await expect(body).not.toContainText('Loading');
  await expect(body).not.toBeEmpty();
  await expect(page.getByRole('list', { name: 'Result state' })).toContainText('Run: Succeeded');

  // The work in between: research notes and the reviews, each its own artifact.
  const between = results(page).getByRole('region', { name: 'Work in between' });
  await expect(between.getByRole('listitem').first()).toBeVisible();
  const firstOther = between.getByRole('button').first();
  const name = (await firstOther.locator('span').first().textContent()) ?? '';
  await firstOther.click();
  await expect(page).toHaveURL(/view=results&result=/);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  const chosen = new URL(page.url()).searchParams.get('result');

  // Source shows the text as written.
  await page.getByText('Source', { exact: true }).click();
  await expect(body.locator('pre')).toBeVisible();

  // To the run view and back: the chosen version stays chosen (WBTST-027).
  await page.getByRole('tab', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Run graph' })).toBeVisible();
  await page.getByRole('tab', { name: 'Results' }).click();
  expect(new URL(page.url()).searchParams.get('result')).toBe(chosen);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();

  // The Output tab names the final result and leads back here.
  await page.getByRole('tab', { name: 'Run', exact: true }).click();
  await page.getByRole('tab', { name: 'Output' }).click();
  await page
    .getByRole('tabpanel')
    .getByRole('button', { name: /^draft v\d+$/ })
    .click();
  await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
  await expect(final.getByRole('button')).toHaveAttribute('aria-current', 'true');
});

test('[WBTST-009] a cancelled run keeps what it made as a partial result', async ({ page }) => {
  await page.goto('/demo?delay=150');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // The decision waits for a person after the drafts and reviews are written.
  await expect(
    page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Cancel whole run', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm whole run cancellation', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Cancelled', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Open run page' }).click();

  await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
  await expect(results(page).getByRole('status')).toContainText('partial results');
  const partial = results(page).getByRole('region', { name: 'Partial results' });
  await expect(partial.getByRole('button').first()).toBeVisible();
  await expect(page.getByTestId('result-body')).not.toBeEmpty();
  await expect(page.getByRole('list', { name: 'Result state' })).toContainText('Run: Cancelled');
});

test('[WBTST-027] a run watched to its end stays on the view it was opened with', async ({
  page,
}) => {
  await page.goto('/demo?template=starter&delay=1200');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('link', { name: 'Open run page' }).click();
  await expect(page.getByRole('tab', { name: 'Run', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await expect(page.getByRole('tab', { name: 'Run', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('application', { name: 'Run graph' })).toBeVisible();
});
