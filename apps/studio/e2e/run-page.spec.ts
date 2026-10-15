import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// The Run page (C-065, C-066) on the in-browser demo team. Demo runs live in the page's worker,
// so these tests reach the Run page through the app's own link instead of reloading.

const approve = async (page: Page, kind: 'Your decision' | 'Final output') => {
  const card = page.locator('[data-testid^="approval-"]').filter({ hasText: kind });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Approve' }).click();
};

async function finishedTeamRun(page: Page) {
  await page.goto('/demo?delay=150');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await approve(page, 'Your decision');
  await approve(page, 'Final output');
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await page.getByRole('link', { name: 'Open run page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_/);
}

const graph = (page: Page) => page.getByRole('application', { name: 'Run graph' });

test('[TC-OBS-001-H] the Run page shows the graph with execution counts, and a node leads to its executions', async ({
  page,
}) => {
  await finishedTeamRun(page);
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(9);
  await expect(page.getByText('Layout from the saved Corral')).toBeVisible();
  const writer = graph(page).locator('.react-flow__node[data-id="write"]');
  await expect(writer).toContainText('2 executions');
  await expect(writer.locator('[data-run-status]')).toHaveAttribute('data-run-status', 'done');

  await writer.click();
  const list = page.getByRole('region', { name: 'Writer executions' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await list.getByRole('button', { name: /Round 2/ }).click();
  await expect(page).toHaveURL(/execution=exec_/);
  const executionId = new URL(page.url()).searchParams.get('execution');
  const reins = page.getByRole('region', { name: 'Reins', exact: true });
  await expect(reins).toContainText(`execution ${executionId}`);
  // The tree row of the chosen execution is marked as the current one.
  await expect(page.locator(`li[data-execution-id="${executionId}"]`)).toHaveAttribute(
    'aria-current',
    'true',
  );
});

test('[TC-OBS-001-H] the header states the run, its progress and the whole-run controls; the output tab opens on success', async ({
  page,
}) => {
  await finishedTeamRun(page);
  const header = page.getByRole('region', { name: 'Run summary' });
  await expect(header).toContainText('Research team');
  await expect(header.getByTestId('run-status')).toContainText('Succeeded');
  await expect(header).toContainText('Review loop: round 2 of 2');
  await expect(header).toContainText(/Tasks completed: \d+ of \d+/);
  const tabs = page.getByRole('tablist', { name: 'Run details' });
  await expect(tabs.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('run-output')).toContainText('Draft 2');

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  await tabs.getByRole('tab', { name: 'Output' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid^="task-"]').first()).toBeVisible();
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Budget' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Budget and usage')).toBeVisible();
});

test('[TC-OBS-001-N] the Run graph cannot be edited: dragging and Delete change nothing', async ({
  page,
}) => {
  await finishedTeamRun(page);
  const writer = graph(page).locator('.react-flow__node[data-id="write"]');
  // A node's place in the graph is its own transform; dragging may pan the view, not move it.
  const position = await writer.getAttribute('style');
  const box = await writer.boundingBox();
  if (!box) throw new Error('no writer node');
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 120, { steps: 8 });
  await page.mouse.up();
  await expect(writer).toHaveAttribute('style', position ?? '');
  await writer.click();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(9);
});

test('[TC-OBS-001-N] a run whose nodes the saved layout does not cover is arranged automatically', async ({
  page,
}) => {
  await page.goto('/demo?template=starter&delay=100');
  // Insert a second agent without saving: the run's definition has a node the saved layout lacks.
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await page.getByLabel('From out').selectOption({ label: 'Output · in' });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.react-flow__node[data-id="agent_1"]').click();
  await page.getByRole('button', { name: 'Remove connection to Output' }).click();
  await page.getByLabel('From out').selectOption({ label: 'Agent 2 · in' });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('link', { name: 'Open run page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_/);
  await expect(page.getByText('Arranged automatically')).toBeVisible();
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(3);
});

test('[TC-UX-001-H] whole-run controls stay reachable at 1280 and 1024px, without page overflow or serious axe findings', async ({
  page,
}) => {
  await page.goto('/demo?delay=4000');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('link', { name: 'Open run page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_/);
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    const header = page.getByRole('region', { name: 'Run summary' });
    await expect(header.getByRole('button', { name: 'Pause run', exact: true })).toBeInViewport();
    await expect(
      header.getByRole('button', { name: 'Cancel whole run', exact: true }),
    ).toBeInViewport();
    await expect(graph(page)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  const serious = (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.length} nodes`);
  expect(serious).toEqual([]);
});
