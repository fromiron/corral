import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

async function trackErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function dropFromPalette(page: Page, kind: 'agent' | 'output', x: number, y: number) {
  await page
    .locator(`[data-palette-item="${kind}"]`)
    .dragTo(page.locator('.react-flow__pane'), { targetPosition: { x, y } });
}

function handle(page: Page, nodeId: string, type: 'source' | 'target') {
  return page.locator(`.react-flow__node[data-id="${nodeId}"] .react-flow__handle.${type}`);
}

async function buildAgentToOutput(page: Page) {
  await dropFromPalette(page, 'agent', 160, 200);
  await dropFromPalette(page, 'output', 520, 200);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await handle(page, 'agent_1', 'source').dragTo(handle(page, 'output_1', 'target'));
  await expect(page.getByText('Ready to run.')).toBeVisible();
}

test('[TC-CAN-001-H] nodes dropped on an empty canvas and connected run as drawn', async ({
  page,
}) => {
  const errors = await trackErrors(page);
  await page.goto('/?delay=50');
  await expect(page.getByText('Demo / Simulated agents')).toBeVisible();

  await buildAgentToOutput(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  await expect(page.getByTestId('run-output')).toContainText('Agent 1 (agent_1) turn 2');
  await expect(page.locator('[data-execution-id]')).toHaveCount(1);
  await expect(
    page.locator('.react-flow__node[data-id="agent_1"] [data-run-status="done"]'),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('[TC-RNS-001-H] an instruction sent during a request reaches the next request', async ({
  page,
}) => {
  const errors = await trackErrors(page);
  await page.goto('/?delay=2500');
  await buildAgentToOutput(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  const box = page.getByLabel('Instruction');
  await box.fill('Use primary sources only.');
  await box.press('Enter');
  await expect(page.getByText('Waiting for the next model request')).toBeVisible();
  const instruction = page.getByRole('listitem').filter({ hasText: 'Use primary sources only.' });
  await expect(instruction).toContainText('Queued');

  await expect(instruction).toContainText('Delivered', { timeout: 10_000 });
  await expect(page.getByTestId('run-output')).toContainText('Use primary sources only.', {
    timeout: 10_000,
  });
  await expect(page.getByText('This execution has finished.', { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an invalid connection is refused with a reason', async ({ page }) => {
  await page.goto('/');
  await dropFromPalette(page, 'agent', 200, 200);
  await handle(page, 'agent_1', 'source').dragTo(handle(page, 'agent_1', 'target'));
  await expect(page.getByTestId('canvas-notice')).toHaveText('A node cannot connect to itself.');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
});

test('the editor has no serious automated accessibility violations', async ({ page }) => {
  await page.goto('/?delay=50');
  await buildAgentToOutput(page);
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.nodes.length} nodes`)).toEqual([]);
});
