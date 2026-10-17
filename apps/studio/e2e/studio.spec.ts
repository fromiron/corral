import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const EXAMPLES = join(import.meta.dirname, '..', '..', '..', 'examples');

async function trackErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function newCorral(page: Page, query = '') {
  await page.goto(`/${query}`);
  await page.getByRole('button', { name: 'New Corral' }).click();
  await expect(page).toHaveURL(/\/corrals\/corral_[a-z0-9]+\/edit/);
}

async function dropFromPalette(page: Page, kind: string, x: number, y: number) {
  await page
    .locator(`[data-palette-item="${kind}"]`)
    .dragTo(page.locator('.react-flow__pane'), { targetPosition: { x, y } });
}

function handle(page: Page, nodeId: string, port: string) {
  return page.locator(
    `.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${port}"]`,
  );
}

async function buildAgentToOutput(page: Page) {
  await dropFromPalette(page, 'agent', 160, 200);
  await dropFromPalette(page, 'output', 520, 200);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await handle(page, 'agent_1', 'out').dragTo(handle(page, 'output_1', 'in'));
  await expect(page.getByText('Ready to run.')).toBeVisible();
}

test('[TC-CAN-001-H] nodes dropped on an empty canvas and connected run as drawn', async ({
  page,
}) => {
  const errors = await trackErrors(page);
  await newCorral(page, '?delay=50');
  await expect(page.getByText('Demo · simulated', { exact: true })).toBeVisible();

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
  await newCorral(page, '?delay=2500');
  await buildAgentToOutput(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  const box = page.getByLabel('Instruction');
  await box.fill('Use primary sources only.');
  await box.press('Enter');
  await expect(page.getByText('Boundary: next model request', { exact: true })).toBeVisible();
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
  await newCorral(page);
  await dropFromPalette(page, 'agent', 200, 200);
  await handle(page, 'agent_1', 'out').dragTo(handle(page, 'agent_1', 'in'));
  await expect(page.getByTestId('canvas-notice')).toHaveText('A node cannot connect to itself.');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
});

test('[TC-CAN-002-H] saving a layout move bumps only the layout revision, and survives reload', async ({
  page,
}) => {
  await newCorral(page);
  await buildAgentToOutput(page);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('revisions')).toHaveText('Definition r2 · Layout r2');

  const node = page.locator('.react-flow__node[data-id="agent_1"]');
  const before = await node.boundingBox();
  if (!before) throw new Error('node not rendered');
  // React Flow starts a drag after real pointer movement, so move in steps.
  await page.mouse.move(before.x + before.width / 2, before.y + 12);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 40, before.y + 160, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('revisions')).toHaveText('Definition r2 · Layout r3');

  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.getByTestId('revisions')).toHaveText('Definition r2 · Layout r3');
  const after = await page.locator('.react-flow__node[data-id="agent_1"]').boundingBox();
  expect(after?.y).not.toBe(before?.y);
});

test('direct links, reload and back navigation keep the right screen', async ({ page }) => {
  await newCorral(page);
  const editorUrl = page.url();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Corrals' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Untitled Corral' })).toBeVisible();
  await page.goto(editorUrl);
  await expect(page.getByLabel('Corral name')).toHaveValue('Untitled Corral');

  await page.goto('/corrals/corral_missing/edit');
  await expect(page.getByText('This page does not exist.')).toBeVisible();
  await page.goto('/runs/run_gone');
  await expect(page.getByText('This run is not available here.', { exact: false })).toBeVisible();
});

test('[TC-CAN-004-H] [TC-RUN-003-H] an imported team with a Loop validates and runs through its review and approvals', async ({
  page,
}) => {
  const errors = await trackErrors(page);
  // Short simulated replies: the team makes about thirty model requests over two rounds.
  await page.goto('/?delay=50');
  await page
    .locator('input[type=file]')
    .setInputFiles([
      join(EXAMPLES, 'research-team.corral.json'),
      join(EXAMPLES, 'research-team.layout.json'),
    ]);
  await expect(page).toHaveURL(/\/edit$/);
  await expect(page.locator('.react-flow__node')).toHaveCount(9);
  await expect(page.locator('.corral-call-link')).toHaveCount(3);
  await expect(page.getByTestId('runtime-limits')).toHaveCount(0);
  await expect(page.getByText('Ready to run.')).toBeVisible();

  // Two review rounds, then the person approves the decision and the final output.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const decision = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' });
  await expect(decision).toBeVisible({ timeout: 15_000 });
  await decision.getByRole('button', { name: 'Continue with this version' }).click();
  const final = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Final output' });
  await expect(final).toBeVisible();
  await final.getByRole('button', { name: 'Confirm as final result' }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await expect(page.locator('[data-testid^="approval-"]')).toHaveCount(0);
  expect(errors).toEqual([]);

  // Break the Loop boundary with the keyboard path: research → write skips "enter".
  await page.locator('.react-flow__node[data-id="research"]').click();
  await page.getByRole('button', { name: /^Remove connection to / }).click();
  await expect(page.getByTestId('diagnostics')).toContainText('flow never reaches');
});

test('[TC-CAN-005-H] keyboard-only connection, duplicate, and one-step undo', async ({ page }) => {
  await newCorral(page);
  await page.getByRole('button', { name: 'Add Agent' }).click();
  await page.getByRole('button', { name: 'Add Output' }).click();
  await page.locator('.react-flow__node[data-id="agent_1"]').click();

  await page.getByLabel('From out').selectOption({ label: 'Output · in' });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(page.getByText('Ready to run.')).toBeVisible();

  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.locator('.react-flow__node[data-id="agent_2"]')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.react-flow__node[data-id="agent_2"]')).toHaveCount(0);
  await page.locator('.react-flow__pane').click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

test('the workspace and editor have no serious automated accessibility violations', async ({
  page,
}) => {
  await page.goto('/');
  const serious = async () =>
    (await new AxeBuilder({ page }).analyze()).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.length} nodes`);
  expect(await serious()).toEqual([]);

  await page.getByRole('button', { name: 'New Corral' }).click();
  await buildAgentToOutput(page);
  await page.locator('.react-flow__node[data-id="agent_1"]').click();
  expect(await serious()).toEqual([]);
});

test('[TC-ART-003-N] a reviewer without the criteria is flagged, and one click gives it them (#20)', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .setInputFiles([
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'packages',
        'core',
        'test',
        'fixtures',
        'research-team.before-criteria-input.corral.json',
      ),
      join(EXAMPLES, 'research-team.layout.json'),
    ]);
  await expect(page).toHaveURL(/\/edit$/);
  const warnings = page.getByTestId('warnings');
  await expect(warnings).toContainText('does not get the criteria');
  // The Corral still runs; the warning says what the review will miss.
  await expect(page.getByText('Ready to run.')).toBeVisible();
  await warnings.getByRole('button', { name: 'Give it the criteria' }).click();
  await expect(warnings).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="review"]').click();
  await expect(page.getByText('criteria · Run input')).toBeVisible();
});
