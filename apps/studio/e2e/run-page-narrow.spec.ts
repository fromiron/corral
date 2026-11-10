import { expect, test } from '@playwright/test';
import { startTestRun } from './workbench.ts';

// The Run page on a phone-width screen: one primary area at a time, nothing off-screen.

test.use({ viewport: { width: 375, height: 812 } });

const graph = (page: import('@playwright/test').Page) =>
  page.getByRole('group', { name: 'Run graph' });

async function finishedRun(page: import('@playwright/test').Page) {
  await page.goto('/demo?template=starter&delay=100');
  await startTestRun(page);
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
  const activity = monitor.getByTestId('run-work-flow');
  await expect(activity).toHaveCount(0);
  await expect(graph(page)).toBeVisible();
  const side = monitor.getByRole('complementary', { name: 'Details', exact: true });
  await expect(side).toBeHidden();
  // The chosen workspace view replaces the graph; it is not a second dock below it.
  await views.getByRole('tab', { name: 'Workflow', exact: true }).click();
  const flow = monitor.getByRole('tabpanel', { name: 'Workflow', exact: true });
  await expect(flow).toBeVisible();
  await expect(activity).toBeVisible();
  await expect(graph(page)).toBeHidden();
  await views.getByRole('tab', { name: 'Workflow', exact: true }).click();
  await expect(flow).toBeVisible();

  const selected = activity.getByRole('button', { name: / · exec_/ }).first();
  await selected.click();
  await expect(side).toBeVisible();
  await expect(activity).toBeHidden();
  await expect(graph(page)).toBeHidden();
  // A finished execution takes no new instructions.
  await expect(side.getByRole('button', { name: 'Give instruction', exact: true })).toHaveCount(0);
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
        const viewport = canvas.querySelector('[data-graph-stage]');
        const nodes = [...canvas.querySelectorAll('[data-agent-id] [data-run-status]')].map(
          (node) => node.getBoundingClientRect(),
        );
        if (!viewport || !nodes.length) return false;
        const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).m11;
        return (
          zoom > 0.25 &&
          nodes.every(
            (node) =>
              node.width > 40 &&
              node.height > 20 &&
              node.left >= bounds.left - 2 &&
              node.right <= bounds.right + 2 &&
              node.top >= bounds.top - 2 &&
              node.bottom <= bounds.bottom + 2,
          )
        );
      }),
    )
    .toBe(true);
  const viewport = graph(page).locator('[data-graph-stage]');
  const initial = await viewport.getAttribute('style');
  await graph(page)
    .getByRole('button', { name: /^zoom in$/i })
    .click();
  await expect(viewport).not.toHaveAttribute('style', initial ?? '');
  const preferred = await viewport.getAttribute('style');
  await views.getByRole('tab', { name: 'Workflow', exact: true }).click();
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
  await expect(graph(page).getByRole('button', { name: /^zoom in$/i })).toBeInViewport();
  await expect(graph(page).getByRole('button', { name: /^fit view$/i })).toBeInViewport();
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
  await expect(views.getByRole('tab', { name: 'Workflow', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('graph controls remain reachable after resizing to a short phone window', async ({ page }) => {
  await finishedRun(page);
  const canvas = graph(page);
  await canvas.getByRole('button', { name: /^fit view$/i }).click();
  await page.setViewportSize({ width: 390, height: 420 });
  await expect(canvas.getByRole('button', { name: /^zoom in$/i })).toBeInViewport();
  await expect(canvas.getByRole('button', { name: /^fit view$/i })).toBeInViewport();
});

test.describe('touch inspection', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('run information remains reachable by touch', async ({ page }) => {
    await finishedRun(page);
    await page.getByRole('button', { name: 'Run info', exact: true }).tap();
    await expect(
      page.getByTestId('run-side').getByRole('heading', { name: 'Run info', exact: true }),
    ).toBeVisible();
  });

  test('a single execution opens in a fitted popover and returns from details to its node', async ({
    page,
  }, testInfo) => {
    await finishedRun(page);
    const monitor = page.getByTestId('run-monitor');
    const canvas = graph(page);
    const node = canvas.locator('[data-agent-id]').getByRole('button');
    await expect(node).toHaveCount(1);
    await node.tap();
    const popup = page.locator('[data-slot="popover-popup"]');
    await expect(popup).toBeVisible();
    await expect(popup.getByRole('listitem')).toHaveCount(1);
    await expect(monitor.getByTestId('run-side')).toBeHidden();
    await expect(canvas).toBeVisible();
    const bounds = await popup.boundingBox();
    if (!bounds) throw new Error('Quick information is not visible');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: testInfo.outputPath('popover-narrow.png') });

    const executionId = await popup.getByRole('listitem').getAttribute('data-execution-id');
    await popup.getByRole('button', { name: 'Details', exact: true }).tap();
    const side = monitor.getByTestId('run-side');
    await expect(side).toBeVisible();
    await expect(canvas).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`execution=${executionId}`));
    await expect(side).toBeFocused();
    await side.getByRole('button', { name: 'Close details', exact: true }).tap();
    await expect(canvas).toBeVisible();
    await expect(node).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(0);
  });
});
