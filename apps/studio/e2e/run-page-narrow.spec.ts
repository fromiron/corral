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
  await expect(page.getByTestId('run-activity')).toBeVisible();
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
  // A secondary view opens in the dock under the column; pressing its tab again folds it.
  await views.getByRole('tab', { name: 'Work flow', exact: true }).click();
  const flow = monitor.getByRole('tabpanel', { name: 'Work flow', exact: true });
  await expect(flow).toBeVisible();
  await expect(activity).toBeVisible();
  await views.getByRole('tab', { name: 'Work flow', exact: true }).click();
  await expect(flow).toBeHidden();

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

test('the dock fits a short window without losing the preferred drag height', async ({ page }) => {
  await finishedRun(page);
  const monitor = page.getByTestId('run-monitor');
  const dock = page.getByTestId('run-dock');
  await dock.getByRole('tab', { name: 'Graph', exact: true }).click();
  // First opening must fit the graph to a real canvas, not to a hidden zero-size panel.
  await expect
    .poll(() =>
      graph(page).evaluate((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        const nodes = [...canvas.querySelectorAll('.react-flow__node')].map((node) =>
          node.getBoundingClientRect(),
        );
        const width =
          Math.max(...nodes.map((node) => node.right)) -
          Math.min(...nodes.map((node) => node.left));
        const height =
          Math.max(...nodes.map((node) => node.bottom)) -
          Math.min(...nodes.map((node) => node.top));
        return Math.max(width / bounds.width, height / bounds.height);
      }),
    )
    .toBeGreaterThan(0.5);
  const handle = dock.getByRole('separator', { name: 'Views height', exact: true });
  const before = Number(await handle.getAttribute('aria-valuenow'));
  const rect = await handle.boundingBox();
  if (!rect) throw new Error('The dock resize handle must be visible');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 - 60, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeGreaterThan(before);
  const preferred = Number(await handle.getAttribute('aria-valuenow'));
  await page.mouse.move(rect.x + rect.width / 2, 10);
  await expect(handle).toHaveAttribute('aria-valuenow', String(preferred));

  await page.setViewportSize({ width: 375, height: 420 });
  await expect
    .poll(async () => {
      const bounds = await dock.boundingBox();
      const available = await monitor.boundingBox();
      return bounds && available
        ? bounds.y + bounds.height <= available.y + available.height + 1
        : false;
    })
    .toBe(true);
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeLessThan(preferred);
  expect(await page.evaluate(() => localStorage.getItem('corral.run.dockHeight'))).toBe(
    String(preferred),
  );
  const main = monitor.locator('[data-testid="run-column"] main');
  await expect.poll(async () => (await main.boundingBox())?.height ?? 0).toBeGreaterThan(80);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(0);
  await expect(dock.getByRole('tablist', { name: 'Execution views' })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('run-dock-short-window.png') });

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(handle).toHaveAttribute('aria-valuenow', String(preferred));
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeLessThan(preferred);
});
