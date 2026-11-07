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

const graph = (page: Page) => page.getByRole('group', { name: 'Run graph' });

test('the first view of a completed run fits every observed agent above the results', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await finishedTeamRun(page);
  await expect(page.getByRole('region', { name: 'Results', exact: true })).toBeVisible();
  const stage = graph(page).locator('[data-graph-pane]');
  await expect(stage.locator('[data-agent-id]')).toHaveCount(5);
  await expect
    .poll(() =>
      stage.evaluate((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        return [...canvas.querySelectorAll<HTMLElement>('[data-agent-id] [data-run-status]')]
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return (
              box.width <= 0 ||
              box.height <= 0 ||
              box.left < bounds.left - 2 ||
              box.right > bounds.right + 2 ||
              box.top < bounds.top - 2 ||
              box.bottom > bounds.bottom + 2
            );
          })
          .map((node) => node.closest<HTMLElement>('[data-agent-id]')?.dataset.agentId);
      }),
    )
    .toEqual([]);
});

test('the Run page shows the graph with execution counts, and a node leads to its executions', async ({
  page,
}) => {
  await finishedTeamRun(page);
  const nodes = graph(page).locator('[data-agent-id]');
  await expect(nodes).toHaveCount(5);
  expect(
    await nodes.evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-agent-id')).sort(),
    ),
  ).toEqual(['helper', 'research', 'respond', 'review', 'write']);
  await expect(graph(page).getByText('Layout from the saved team')).toHaveCount(0);
  const writer = graph(page).locator('[data-agent-id="write"]');
  await expect(writer).toContainText('2 executions');
  await expect(writer.locator('[data-run-status]')).toHaveAttribute('data-run-status', 'done');

  const writerButton = writer.getByRole('button');
  await writerButton.click();
  const list = page.getByRole('region', { name: 'Writer executions' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  const round2 = list.getByRole('listitem').filter({ hasText: 'Round 2' });
  const executionId = await round2.getAttribute('data-execution-id');
  expect(executionId).toBeTruthy();
  const round2Details = round2.getByRole('button', { name: 'Details', exact: true });
  await expect(round2Details).toHaveAccessibleDescription(
    /Agent execution \d+ · Round 2 · Attempt 1/,
  );
  await round2Details.click();
  await expect(page).toHaveURL(new RegExp(`execution=${executionId}`));
  const monitor = page.getByTestId('run-monitor');
  const side = monitor.getByTestId('run-side');
  await expect(side).toBeVisible();
  await expect(side).toBeFocused();
  await side.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(writerButton).toBeFocused();
  await writerButton.click();
  await list
    .locator(`li[data-execution-id="${executionId}"]`)
    .getByRole('button', { name: 'Details', exact: true })
    .click();
  const openReins = side.getByRole('button', { name: 'Reins', exact: true });
  await openReins.click();
  const reins = monitor.getByTestId('run-instructions');
  await expect(reins).toBeVisible();
  await expect(reins).toContainText('Writer');
  await expect(reins).toContainText('This execution has finished.');
  await expect(reins.getByLabel('Instruction', { exact: true })).toHaveCount(0);
  await expect(side).toBeHidden();
  await reins.getByRole('button', { name: 'Back to work', exact: true }).click();
  await expect(openReins).toBeFocused();
  await monitor.getByRole('tab', { name: 'Work flow', exact: true }).click();
  // The work flow card of the chosen execution is marked as the current one.
  const activity = page.getByTestId('run-work-flow');
  await expect(
    activity
      .getByRole('treeitem', { selected: true })
      .locator(`[data-execution-id="${executionId}"]`)
      .first(),
  ).toBeVisible();

  // Work flow and graph are alternative views of the same explicit execution selection.
  await activity
    .getByRole('button', { name: /^Research · exec_/ })
    .first()
    .click();
  await monitor.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(
    graph(page).locator('[data-agent-id="research"]').getByRole('button'),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(writer.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
  await page.goBack();
  await expect(writer.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(new RegExp(`execution=${executionId}`));
  await expect(side.getByRole('heading', { name: 'Writer', exact: true })).toBeVisible();
  await page.goForward();
  await expect(
    graph(page).locator('[data-agent-id="research"]').getByRole('button'),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(writer.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
});

test('quick inspection keeps the graph size and the existing execution inspector', async ({
  page,
}, testInfo) => {
  await finishedTeamRun(page);
  const monitor = page.getByTestId('run-monitor');
  const side = monitor.getByTestId('run-side');
  const canvas = graph(page);
  const writer = canvas.locator('[data-agent-id="write"]').getByRole('button');
  const research = canvas.locator('[data-agent-id="research"]').getByRole('button');
  const width = (await canvas.boundingBox())?.width;
  await writer.click();
  const writerList = page.getByRole('region', { name: 'Writer executions' });
  await expect(writerList.getByRole('listitem')).toHaveCount(2);
  await expect(side).toBeHidden();
  expect((await canvas.boundingBox())?.width).toBe(width);
  await page.screenshot({ path: testInfo.outputPath('popover-desktop-multiple.png') });

  await research.click();
  const researchList = page.getByRole('region', { name: 'Research executions' });
  await expect(researchList.getByRole('listitem')).toHaveCount(1);
  await expect(writerList).toBeHidden();
  await expect(page.locator('[data-slot="popover-popup"]')).toHaveCount(1);
  await writer.click();
  await expect(writerList).toBeVisible();
  const selected = writerList.getByRole('listitem').first();
  const selectedId = await selected.getAttribute('data-execution-id');
  await selected.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(side.getByRole('heading', { name: 'Writer', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`execution=${selectedId}`));
  const inspectedWidth = (await canvas.boundingBox())?.width;
  await research.click();
  await expect(researchList.getByRole('listitem')).toHaveCount(1);
  await expect(side.getByRole('heading', { name: 'Writer', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`execution=${selectedId}`));
  expect((await canvas.boundingBox())?.width).toBe(inspectedWidth);
  await page.screenshot({ path: testInfo.outputPath('popover-desktop-inspector.png') });
  await page.getByRole('button', { name: 'Close quick information', exact: true }).click();
  await expect(researchList).toBeHidden();
  await expect(side.getByRole('heading', { name: 'Writer', exact: true })).toBeVisible();
});

test('keyboard, outside click and graph movement dismiss quick information', async ({ page }) => {
  await finishedTeamRun(page);
  const canvas = graph(page);
  const writer = canvas.locator('[data-agent-id="write"]').getByRole('button');
  const list = page.getByRole('region', { name: 'Writer executions' });
  const viewport = canvas.locator('[data-graph-stage]');
  await canvas.getByRole('button', { name: /^zoom in$/i }).click();
  const preferred = await viewport.getAttribute('style');
  await writer.focus();
  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(writer).toBeFocused();
  await expect(viewport).toHaveAttribute('style', preferred ?? '');

  await writer.click();
  await expect(list).toBeVisible();
  await page.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(list).toBeHidden();
  await expect(viewport).toHaveAttribute('style', preferred ?? '');

  await writer.click();
  await expect(list).toBeVisible();
  const pane = canvas.locator('[data-graph-pane]');
  const box = await pane.boundingBox();
  if (!box) throw new Error('Graph pane is not visible');
  const scale = await viewport.evaluate(
    (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m11,
  );
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 45, { steps: 5 });
  await page.mouse.up();
  await expect(list).toBeHidden();
  expect(
    await viewport.evaluate(
      (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m11,
    ),
  ).toBe(scale);
  await expect(writer).toHaveAttribute('aria-pressed', 'true');
});

test('dismissing quick information on an outside control keeps focus on that control', async ({
  page,
}) => {
  await finishedTeamRun(page);
  const writer = graph(page).locator('[data-agent-id="write"]').getByRole('button');
  await writer.click();
  const list = page.getByRole('region', { name: 'Writer executions' });
  await expect(list).toBeVisible();
  const runInfo = page.getByRole('button', { name: 'Run info', exact: true });
  await runInfo.click();
  await expect(list).toBeHidden();
  await expect(page.locator('[data-slot="popover-popup"]')).toHaveCount(0);
  await expect(page.getByTestId('run-side')).toBeVisible();
  await expect(runInfo).toBeFocused();
});

test('Escape after opening a node quick view restores focus to its node', async ({ page }) => {
  await finishedTeamRun(page);
  const writer = graph(page).locator('[data-agent-id="write"]');
  const runInfo = page.getByRole('button', { name: 'Run info', exact: true });
  await runInfo.focus();
  await writer.getByRole('button').click();
  const list = page.getByRole('region', { name: 'Writer executions' });
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(page.locator('[data-slot="popover-popup"]')).toHaveCount(0);
  await expect(writer.getByRole('button')).toBeFocused();
});

test('the Run graph cannot be edited: dragging and Delete change nothing', async ({ page }) => {
  await finishedTeamRun(page);
  const writer = graph(page).locator('[data-agent-id="write"]');
  // A node's place in the graph is its own transform; dragging may pan the view, not move it.
  const position = await writer.getAttribute('style');
  const box = await writer.boundingBox();
  if (!box) throw new Error('no writer node');
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 120, { steps: 8 });
  await page.mouse.up();
  await expect(writer).toHaveAttribute('style', position ?? '');
  await writer.getByRole('button').click();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await expect(graph(page).locator('[data-agent-id]')).toHaveCount(5);
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
