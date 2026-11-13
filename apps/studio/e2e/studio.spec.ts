import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { newTeam, openLibraryTeams } from './workbench.ts';

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
  await openLibraryTeams(page);
  await newTeam(page);
  await expect(page).toHaveURL(/\/corrals\/corral_[a-z0-9]+\/edit/);
}

const canvas = (page: Page) => page.locator('[data-team-canvas]');
const nodes = (page: Page) => canvas(page).locator('[data-node]');
const edges = (page: Page) => canvas(page).locator('[data-edge]');
const settings = (page: Page) => page.getByRole('complementary', { name: 'Settings' });
const noProblems = (page: Page) => page.getByRole('button', { name: 'No problems', exact: true });

/**
 * Drags a palette step onto the canvas's empty lower-left corner: away from the palette, from
 * the fitted cards in the middle, and from the settings sheet on the right.
 */
async function dropOnCanvas(page: Page, kind: string) {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not rendered');
  await page
    .getByRole('button', { name: `Add ${kind}`, exact: true })
    .dragTo(canvas(page), { targetPosition: { x: 40, y: box.height - 40 } });
}

async function buildAgentToOutput(page: Page) {
  await dropOnCanvas(page, 'Agent');
  await expect(nodes(page)).toHaveCount(1);
  // A drop on empty canvas ignores the selection, so the output lands unconnected.
  await dropOnCanvas(page, 'Output');
  await expect(nodes(page)).toHaveCount(2);
  await expect(edges(page)).toHaveCount(0);
  await canvas(page)
    .locator('[data-port="agent_1:out"]')
    .dragTo(canvas(page).locator('[data-node="output_1"]').first());
  await expect(edges(page)).toHaveCount(1);
  await expect(noProblems(page)).toBeVisible();
}

async function openTestRun(page: Page) {
  const open = page.getByRole('button', { name: 'Test run', exact: true });
  if (await open.isVisible()) await open.click();
  const panel = page.getByRole('complementary', { name: 'Test run' });
  await expect(panel).toBeVisible();
  return panel;
}

test('steps dropped on an empty canvas and connected run as drawn', async ({ page }) => {
  const errors = await trackErrors(page);
  await newCorral(page, '?delay=50');
  await expect(page.getByTestId('sidebar-connection')).toHaveText('Demo');

  await buildAgentToOutput(page);
  const brief = 'Compare notebook formats for field notes.';
  await page.getByRole('button', { name: 'Limits and criteria', exact: true }).click();
  await settings(page).getByRole('textbox', { name: 'Brief', exact: true }).fill(brief);
  const panel = await openTestRun(page);
  await panel.getByRole('button', { name: 'Run', exact: true }).click();

  await expect(page.getByTestId('run-status')).toContainText('Completed');
  await expect(page.getByTestId('run-output')).toContainText(
    'Simulated Agent 1 reply, request 2 of 2. No model was called.',
  );
  await expect(page.getByTestId('run-output')).toContainText(brief);
  await expect(panel.locator('[data-execution-id]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a saved team survives a settings detour and a reload, and saving it unchanged keeps its version', async ({
  page,
}) => {
  await newCorral(page);
  await buildAgentToOutput(page);
  // Settings is a detour, not an instruction to discard an unsaved graph.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('settings-sidebar')).toBeVisible();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect(page.getByTestId('revisions')).toHaveText('Version 2');
  await expect(save).toBeDisabled();

  // An edit undone back to the saved team leaves nothing to save.
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await expect(save).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(save).toBeDisabled();

  await page.reload();
  await expect(nodes(page)).toHaveCount(2);
  await expect(edges(page)).toHaveCount(1);
  await expect(page.getByTestId('revisions')).toHaveText('Version 2');
});

test('an imported team with a Loop validates and runs through its review and approvals', async ({
  page,
}) => {
  const errors = await trackErrors(page);
  // Short simulated replies: the team makes about thirty model requests over two rounds.
  await page.goto('/?delay=50');
  await openLibraryTeams(page);
  await page
    .locator('input[type=file]')
    .setInputFiles([join(EXAMPLES, 'research-team.corral.json')]);
  await expect(page).toHaveURL(/\/edit$/);
  await expect(nodes(page)).toHaveCount(9);
  await expect(canvas(page).locator('[data-box]')).toHaveCount(1);
  // Call links are the dashed connections, named by what they do.
  await expect(edges(page).filter({ hasText: /^(delegates|asks)$/ })).toHaveCount(3);
  await expect(noProblems(page)).toBeVisible();

  // Two review rounds, then the person approves the decision and the final output.
  const panel = await openTestRun(page);
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  const decision = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' });
  await expect(decision).toBeVisible({ timeout: 15_000 });
  await decision.getByRole('button', { name: 'Continue with this version' }).click();
  const final = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Final output' });
  await expect(final).toBeVisible();
  await final.getByRole('button', { name: 'Confirm as final result' }).click();
  await expect(page.getByTestId('run-status')).toContainText('Completed');
  await expect(page.locator('[data-testid^="approval-"]')).toHaveCount(0);
  expect(errors).toEqual([]);

  // Cutting the way into the Loop leaves its steps unreachable, and the problem names them.
  await canvas(page).locator('[data-node="research"]').click();
  await settings(page)
    .getByRole('button', { name: /^Remove the connection from / })
    .click();
  await expect(noProblems(page)).toHaveCount(0);
  await page.getByRole('button', { name: /^\d+ problems?$/ }).click();
  await expect(settings(page)).toContainText('The flow never reaches');
});

test('a connection from the settings list, a wrap and one-step undo work without a pointer path', async ({
  page,
}) => {
  await newCorral(page);
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  // With nothing selected the output lands on its own, unconnected.
  await canvas(page).press('Escape');
  await page.getByRole('button', { name: 'Add Output', exact: true }).click();
  await expect(edges(page)).toHaveCount(0);
  await canvas(page).locator('[data-node="agent_1"]').click();

  await settings(page).getByRole('combobox', { name: 'Connect out to…', exact: true }).click();
  await page.getByRole('option', { name: 'Output', exact: true }).click();
  await expect(edges(page)).toHaveCount(1);
  await expect(noProblems(page)).toBeVisible();

  await settings(page).getByRole('button', { name: 'Wrap in a Loop', exact: true }).click();
  await expect(canvas(page).locator('[data-box]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(canvas(page).locator('[data-box]')).toHaveCount(0);
  await expect(edges(page)).toHaveCount(1);
  await canvas(page).press('Control+z');
  await expect(edges(page)).toHaveCount(0);
  await canvas(page).press('Control+Shift+z');
  await expect(edges(page)).toHaveCount(1);
});

test('the workspace and editor have no serious automated accessibility violations', async ({
  page,
}) => {
  await page.goto('/');
  const serious = async () =>
    (await new AxeBuilder({ page }).analyze()).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ rule: v.id, targets: v.nodes.map((node) => node.target) }));
  expect(await serious()).toEqual([]);

  await openLibraryTeams(page);
  await newTeam(page);
  await buildAgentToOutput(page);
  // The view keeps the selected output clear of the sheet, so the agent is chosen from the list.
  await page
    .getByRole('complementary', { name: 'Team structure' })
    .getByRole('button', { name: 'Agent 1', exact: true })
    .click();
  await expect(settings(page).getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
  expect(await serious()).toEqual([]);
});

test('a reviewer without the criteria is flagged, and one click gives it them (#20)', async ({
  page,
}) => {
  const errors = await trackErrors(page);
  await page.goto('/');
  await openLibraryTeams(page);
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
    ]);
  await expect(page).toHaveURL(/\/edit$/);
  // A warning: the team still runs, and the problem says what the review will miss.
  await page.getByRole('button', { name: '1 problem', exact: true }).click();
  const problem = settings(page).getByRole('button', { name: /does not get the criteria/ });
  await expect(problem).toBeVisible();
  await problem.click();
  await expect(
    settings(page).getByRole('textbox', { name: 'Name', exact: true }).first(),
  ).toHaveValue('검토');
  await settings(page).getByRole('button', { name: 'Add a criteria input', exact: true }).click();
  await expect(noProblems(page)).toBeVisible();
  await expect(settings(page).getByRole('group', { name: 'Inputs', exact: true })).toContainText(
    'criteria · Run input',
  );
  expect(errors).toEqual([]);
});
