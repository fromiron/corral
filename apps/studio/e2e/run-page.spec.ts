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
  // a finished run opens on its results; these checks are about the run view.
  await page.getByRole('tab', { name: 'Execution', exact: true }).click();
}

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
  const reins = page.getByRole('region', { name: 'Reins', exact: true });
  await expect(reins).toContainText(`execution ${executionId}`);
  // The tree row of the chosen execution is marked as the current one.
  await expect(page.locator(`li[data-execution-id="${executionId}"]`)).toHaveAttribute(
    'aria-current',
    'true',
  );

  // Choosing another role from the tree must also update the previously selected graph node.
  await page
    .locator('li[data-execution-id]')
    .filter({ hasText: /^Research ·/ })
    .getByRole('button', { name: 'Steer', exact: true })
    .first()
    .click();
  await expect(graph(page).locator('.react-flow__node[data-id="research"]')).toHaveClass(
    /selected/,
  );
  await expect(writer).not.toHaveClass(/selected/);
  await page.goBack();
  await expect(writer).toHaveClass(/selected/);
  await expect(reins).toContainText(`execution ${executionId}`);
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

test('the Budget tab lists each request’s effort judgment as observe only', async ({ page }) => {
  await finishedTeamRun(page);
  const tabs = page.getByRole('tablist', { name: 'Run details' });
  await tabs.getByRole('tab', { name: 'Budget' }).click();
  const judgments = page.getByRole('region', { name: 'Effort judgments' });
  await expect(judgments).toContainText('Observe only. Not applied to any request.');
  await expect(judgments.locator('[data-testid^="judgment-call_"]').first()).toContainText(
    'local-heuristic@1',
  );
  // The demo's rule baseline is labelled as a rule, not a model probability.
  await expect(judgments).toContainText('(rule)');
});
