import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

const modeLabels = {
  live: 'Live models (uses your sign-in)',
  mock: 'Simulated (no model or extension calls)',
};

async function chooseMode(page: Page, value: keyof typeof modeLabels) {
  const mode = page.getByRole('combobox', { name: 'Agents', exact: true });
  await mode.click();
  await page.getByRole('option', { name: modeLabels[value], exact: true }).click();
  // The kit acknowledges the selected row before closing. Wait for that popup to
  // close so the next explicit choice opens it, instead of toggling it closed.
  await expect(mode).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('listbox')).toBeHidden();
}

async function importTeam(page: Page, id: string) {
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await page.getByRole('tab', { name: /^Teams/ }).click();
  const definition = linearCorral(['writer'], id);
  definition.name = id;
  await page.locator('input[type=file]').setInputFiles({
    name: `${id}.corral.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(definition)),
  });
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
}

test('another team never inherits the previous run or its canvas status', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await importTeam(page, 'team-a');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await importTeam(page, 'team-b');
  await expect(page.getByTestId('run-status')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open execution page' })).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="output"]')).not.toContainText('Completed');
  expect(corral.server.coordinator.listRuns()).toHaveLength(1);
});

test.describe('explicit live selection', () => {
  test.use({ live: true, codexLogin: true });
  test('remembers live for this editor after reload, but not another team', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await importTeam(page, 'team-a');
    await chooseMode(page, 'live');
    await page.reload();
    await page.getByRole('tab', { name: 'Test run', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Agents', exact: true })).toContainText(
      modeLabels.live,
    );
    const path = new URL(page.url()).pathname;
    await corral.restart();
    await corral.open(path);
    await page.getByRole('tab', { name: 'Test run', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Agents', exact: true })).toContainText(
      modeLabels.live,
    );
    await importTeam(page, 'team-b');
    await expect(page.getByRole('combobox', { name: 'Agents', exact: true })).toContainText(
      modeLabels.mock,
    );
    expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  });
});

test('role reasoning survives save, reload and undo', async ({ page, corral }) => {
  await corral.open('/');
  await importTeam(page, 'reasoning-editor');
  await page.getByRole('group', { name: 'agent: writer', exact: true }).click();
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true });
  await effort.click();
  await page.getByRole('option', { name: 'Low', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('group', { name: 'agent: writer', exact: true }).click();
  await expect(effort).toContainText('Low');
  await effort.click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(effort).toContainText('Low');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByText('Model and reasoning for this run', { exact: true }).click();
  const oneRun = page.getByTestId('run-role-overrides');
  await oneRun.getByRole('combobox', { name: 'Reasoning effort', exact: true }).click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await page.getByText('Model and reasoning for this run', { exact: true }).click();
  await expect(oneRun.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveCount(
    0,
  );
  await page.getByText('Model and reasoning for this run', { exact: true }).click();
  await expect(
    oneRun.getByRole('combobox', { name: 'Reasoning effort', exact: true }),
  ).toContainText('High');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await expect(page.getByTestId('reasoning-summary').first()).toContainText('high');
  const run = corral.server.coordinator.listRuns()[0];
  expect(
    corral.server.coordinator.getRunSnapshot(run!.runId)?.definition.roles[0]?.reasoning,
  ).toEqual({ mode: 'fixed', level: 'high' });
  await page.reload();
  await page.getByRole('group', { name: 'agent: writer', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toContainText(
    'Low',
  );
});

test.describe('ordered explicit mode choices', () => {
  test.use({ live: true, codexLogin: true });
  test('a delayed older live choice cannot overwrite the latest mock choice', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await importTeam(page, 'ordered-mode');
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route('**/api/v1/run-modes', async (route) => {
      if (route.request().method() === 'PUT' && route.request().postDataJSON().mode === 'live') {
        entered();
        await held;
      }
      await route.continue();
    });
    const liveSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith('/run-modes') &&
        response.request().postDataJSON().mode === 'live',
    );
    const mockSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith('/run-modes') &&
        response.request().postDataJSON().mode === 'mock',
    );
    const mode = page.getByRole('combobox', { name: 'Agents', exact: true });
    await chooseMode(page, 'live');
    await first;
    await chooseMode(page, 'mock');
    await expect(mode).toContainText(modeLabels.mock);
    release();
    await Promise.all([liveSaved, mockSaved]);
    await page.reload();
    await page.getByRole('tab', { name: 'Test run', exact: true }).click();
    await expect(mode).toContainText(modeLabels.mock);
  });
});
