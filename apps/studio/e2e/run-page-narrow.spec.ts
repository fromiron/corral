import { expect, test } from '@playwright/test';

// The Run page on a phone-width screen: one primary area at a time, nothing off-screen.

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
  await expect(graph(page)).toBeVisible();
}

test('a narrow Run page shows one panel at a time and never scrolls sideways', async ({ page }) => {
  await finishedRun(page);
  const monitor = page.getByTestId('run-monitor');
  const views = monitor.getByRole('tablist', { name: 'Execution views' });
  await expect(views).toBeVisible();
  const activity = monitor.getByTestId('run-activity');
  await expect(activity).toHaveCount(0);
  await expect(graph(page)).toBeVisible();
  const side = monitor.getByRole('complementary', { name: 'Details', exact: true });
  await expect(side).toBeHidden();
  // The chosen workspace view replaces the graph; it is not a second dock below it.
  await views.getByRole('tab', { name: 'Work flow', exact: true }).click();
  const flow = monitor.getByRole('tabpanel', { name: 'Work flow', exact: true });
  await expect(flow).toBeVisible();
  await expect(activity).toBeVisible();
  await expect(graph(page)).toBeHidden();
  await views.getByRole('tab', { name: 'Work flow', exact: true }).click();
  await expect(flow).toBeVisible();

  const selected = activity.locator('button[data-execution-id]').first();
  await selected.click();
  await expect(side).toBeVisible();
  await expect(activity).toBeHidden();
  await expect(graph(page)).toBeHidden();
  await side.getByRole('button', { name: 'Reins', exact: true }).click();
  const reins = monitor.getByTestId('run-instructions');
  await expect(reins).toBeVisible();
  await expect(reins).toContainText('This execution has finished.');
  await expect(reins.getByLabel('Instruction', { exact: true })).toHaveCount(0);
  await expect(side).toBeHidden();
  await expect(flow).toBeHidden();

  await reins.getByRole('button', { name: 'Back to work', exact: true }).click();
  await expect(side).toBeVisible();
  await side.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(side).toBeHidden();
  await expect(selected).toBeFocused();
  await views.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(graph(page)).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('region', { name: 'Execution summary' })).toBeVisible();
});

test('the primary graph fits a short window and keeps its zoom across view and size changes', async ({
  page,
}) => {
  await finishedRun(page);
  const monitor = page.getByTestId('run-monitor');
  const views = monitor.getByRole('tablist', { name: 'Execution views', exact: true });
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
  const viewport = graph(page).locator('.react-flow__viewport');
  const initial = await viewport.getAttribute('style');
  await graph(page)
    .getByRole('button', { name: /^zoom in$/i })
    .click();
  await expect(viewport).not.toHaveAttribute('style', initial ?? '');
  const preferred = await viewport.getAttribute('style');
  await views.getByRole('tab', { name: 'Work flow', exact: true }).click();
  await expect(graph(page)).toBeHidden();
  await views.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(viewport).toHaveAttribute('style', preferred ?? '');

  await page.setViewportSize({ width: 375, height: 420 });
  await expect
    .poll(async () => {
      const bounds = await monitor.getByTestId('run-column').boundingBox();
      const available = await monitor.boundingBox();
      return bounds && available
        ? bounds.y + bounds.height <= available.y + available.height + 1
        : false;
    })
    .toBe(true);
  await expect(viewport).toHaveAttribute('style', preferred ?? '');
  await expect.poll(async () => (await graph(page).boundingBox())?.height ?? 0).toBeGreaterThan(80);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(0);
  await expect(views).toBeInViewport();
  await expect(monitor.getByRole('button', { name: 'Run info', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('run-workspace-short-window.png') });

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(viewport).toHaveAttribute('style', preferred ?? '');
  await views.getByRole('tab', { name: 'Graph', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(views.getByRole('tab', { name: 'Work flow', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
