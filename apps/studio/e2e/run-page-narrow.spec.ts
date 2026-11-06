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
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

test('a narrow Run page shows one panel at a time and never scrolls sideways', async ({ page }) => {
  await finishedRun(page);
  const monitor = page.getByTestId('run-monitor');
  const views = monitor.getByRole('tablist', { name: 'Execution views' });
  await expect(views).toBeVisible();
  const activity = monitor.getByTestId('run-activity');
  await expect(activity).toBeVisible();
  await expect(graph(page)).toBeHidden();
  await expect(page.getByRole('region', { name: 'Reins', exact: true })).toBeHidden();
  await views.getByRole('tab', { name: 'Work flow', exact: true }).click();
  const flow = monitor.getByRole('tabpanel', { name: 'Work flow', exact: true });
  await expect(flow).toBeVisible();
  await expect(activity).toBeHidden();
  await views.getByRole('tab', { name: 'Activity', exact: true }).click();

  // Choosing an execution opens the side panel in place of the column; Reins remains a tab.
  await activity.locator('button[data-execution-id]').first().click();
  const side = monitor.getByRole('complementary', { name: 'Details', exact: true });
  await expect(side).toBeVisible();
  await expect(activity).toBeHidden();
  await expect(graph(page)).toBeHidden();
  await monitor.getByRole('tab', { name: 'Reins', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Reins', exact: true })).toBeVisible();
  await expect(flow).toBeHidden();

  await monitor.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(monitor.getByRole('tablist', { name: 'Details', exact: true })).toBeVisible();
  await side.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(side).toBeHidden();
  await views.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(graph(page)).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('region', { name: 'Execution summary' })).toBeVisible();
});
