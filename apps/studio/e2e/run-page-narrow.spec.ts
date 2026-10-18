import { expect, test } from '@playwright/test';

// Roadmap 19: the Run page on a phone-width screen: one panel at a time, nothing off-screen.

test.use({ viewport: { width: 375, height: 812 } });

async function finishedRun(page: import('@playwright/test').Page) {
  await page.goto('/demo?template=starter&delay=100');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page).toHaveURL(/\/runs\//);
  // CR-009: a finished run opens on its results; these checks are about the run view.
  await page.getByRole('tab', { name: 'Execution', exact: true }).click();
}

test('[TC-UX-001-H] a narrow Run page shows one panel at a time and never scrolls sideways', async ({
  page,
}) => {
  await finishedRun(page);
  const views = page.getByRole('tablist', { name: 'Run view' });
  await expect(views).toBeVisible();
  await expect(views.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Reins', exact: true })).toBeHidden();

  await views.getByRole('tab', { name: 'Calls' }).click();
  await expect(page.getByRole('heading', { name: 'Executions' })).toBeVisible();
  await expect(page.locator('.react-flow')).toBeHidden();
  // Choosing a call opens its conversation and the Reins.
  await page.locator('li[data-execution-id]').first().getByRole('button').first().click();
  await expect(views.getByRole('tab', { name: 'Conversation & Reins' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('region', { name: 'Reins', exact: true })).toBeVisible();

  await views.getByRole('tab', { name: 'Details' }).click();
  await expect(page.getByRole('tablist', { name: 'Run details' })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('region', { name: 'Execution summary' })).toBeVisible();
});
