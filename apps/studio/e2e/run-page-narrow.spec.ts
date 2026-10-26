import { expect, test } from '@playwright/test';

// Roadmap 19: the Run page on a phone-width screen: one panel at a time, nothing off-screen.

test.use({ viewport: { width: 375, height: 812 } });

const graph = (page: import('@playwright/test').Page) =>
  page.getByRole('application', { name: 'Run graph' });

async function finishedRun(page: import('@playwright/test').Page) {
  await page.goto('/demo?template=starter&delay=100');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByRole('tab', { name: 'Graph', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

test('a narrow Run page shows one panel at a time and never scrolls sideways', async ({ page }) => {
  await finishedRun(page);
  const monitor = page.getByTestId('run-monitor');
  const views = monitor.getByRole('tablist', { name: 'Execution views' });
  await expect(views).toBeVisible();
  await expect(views.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Reins', exact: true })).toBeHidden();

  await monitor.getByRole('button', { name: 'Executions', exact: true }).click();
  await expect(
    monitor.getByRole('complementary', { name: 'Executions', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.react-flow')).toBeHidden();
  // Choosing a call opens its details; Reins remains an explicit tab.
  await page.locator('li[data-execution-id]').first().getByRole('button').first().click();
  await monitor.getByRole('tab', { name: 'Reins', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Reins', exact: true })).toBeVisible();

  await monitor.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(monitor.getByRole('tablist', { name: 'Details', exact: true })).toBeVisible();
  await views.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(graph(page)).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('region', { name: 'Execution summary' })).toBeVisible();
});
