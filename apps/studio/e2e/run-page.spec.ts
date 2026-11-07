import { expect, type Page, test } from '@playwright/test';

// The Run page on the in-browser demo team. Demo runs live in the page's worker,
// so these tests reach the Run page through the app's own link instead of reloading.

const approve = async (page: Page, kind: 'Your decision' | 'Final output') => {
  const card = page.locator('[data-testid^="approval-"]').filter({ hasText: kind });
  await expect(card).toBeVisible({ timeout: 20_000 });
  // UX-11: each step's button says what approving it does.
  await card
    .getByRole('button', {
      name: kind === 'Final output' ? 'Confirm as final result' : 'Continue with this version',
    })
    .click();
};

async function finishedTeamRun(page: Page) {
  await page.goto('/demo?delay=150');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await approve(page, 'Your decision');
  await approve(page, 'Final output');
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_/);
  await expect(graph(page)).toBeVisible();
  await expect(page.getByTestId('run-side')).toBeHidden();
}

// Wide enough for the run column and the side panel side by side.
test.use({ viewport: { width: 1600, height: 900 } });

const graph = (page: Page) => page.getByRole('application', { name: 'Run graph' });

test('the Run page shows the graph with execution counts, and a node leads to its executions', async ({
  page,
}) => {
  await finishedTeamRun(page);
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(9);
  await expect(page.getByText('Layout from the saved team')).toBeVisible();
  const writer = graph(page).locator('.react-flow__node[data-id="write"]');
  await expect(writer).toContainText('2 executions');
  await expect(writer.locator('[data-run-status]')).toHaveAttribute('data-run-status', 'done');

  await writer.click();
  const list = page.getByRole('region', { name: 'Writer executions' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await list.getByRole('button', { name: /Round 2/ }).click();
  await expect(page).toHaveURL(/execution=exec_/);
  const executionId = new URL(page.url()).searchParams.get('execution');
  const monitor = page.getByTestId('run-monitor');
  const side = monitor.getByTestId('run-side');
  await side.getByRole('button', { name: 'Reins', exact: true }).click();
  const reins = monitor.getByTestId('run-instructions');
  await expect(reins).toBeVisible();
  await expect(reins).toContainText('Writer');
  await expect(reins).toContainText('This execution has finished.');
  await expect(reins.getByLabel('Instruction', { exact: true })).toHaveCount(0);
  await expect(side).toBeHidden();
  await reins.getByRole('button', { name: 'Back to work', exact: true }).click();
  await monitor.getByRole('tab', { name: 'Work flow', exact: true }).click();
  // The activity entry of the chosen execution is marked as the current one.
  const activity = page.getByTestId('run-activity');
  await expect(activity.locator(`button[data-execution-id="${executionId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Activity and graph are alternative views of the same explicit execution selection.
  await activity
    .getByRole('button', { name: /^Research\b/ })
    .first()
    .click();
  await monitor.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(graph(page).locator('.react-flow__node[data-id="research"]')).toHaveClass(
    /selected/,
  );
  await expect(writer).not.toHaveClass(/selected/);
  await page.goBack();
  await expect(writer).toHaveClass(/selected/);
  await expect(page).toHaveURL(new RegExp(`execution=${executionId}`));
  await expect(side.getByRole('heading', { name: 'Writer', exact: true })).toBeVisible();
  await page.goForward();
  await expect(graph(page).locator('.react-flow__node[data-id="research"]')).toHaveClass(
    /selected/,
  );
  await expect(writer).not.toHaveClass(/selected/);
});

test('the Run graph cannot be edited: dragging and Delete change nothing', async ({ page }) => {
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

test('the Usage tab lists each request’s effort judgment as observe only', async ({ page }) => {
  await finishedTeamRun(page);
  await page.getByRole('button', { name: 'Run info', exact: true }).click();
  await page.getByTestId('run-monitor').getByRole('tab', { name: 'Usage', exact: true }).click();
  const judgments = page.getByRole('region', { name: 'Effort judgments' });
  await expect(judgments).toContainText('Observe only. Not applied to any request.');
  await expect(judgments.locator('[data-testid^="judgment-call_"]').first()).toContainText(
    'local-heuristic@1',
  );
  // The demo's rule baseline is labelled as a rule, not a model probability.
  await expect(judgments).toContainText('(rule)');
});
