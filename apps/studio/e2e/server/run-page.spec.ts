import { join } from 'node:path';
import { expect, test } from './harness.ts';

const EXAMPLES = join(import.meta.dirname, '..', '..', '..', '..', 'examples');

async function finishedRun(
  page: import('@playwright/test').Page,
  corral: { open(path?: string): Promise<void> },
) {
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles([
      join(EXAMPLES, 'research-brief.corral.json'),
      join(EXAMPLES, 'research-brief.layout.json'),
    ]);
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_[a-f0-9]+$/);
  // CR-009: a finished run opens on its results; these checks are about the run view.
  await page.getByRole('tab', { name: 'Execution', exact: true }).click();
  return new URL(page.url()).pathname;
}

test('[TC-OBS-001-H] a reload keeps the chosen execution and the saved layout', async ({
  page,
  corral,
}) => {
  await finishedRun(page, corral);
  await expect(page.getByText('Layout from the saved team')).toBeVisible();
  const row = page.locator('li[data-execution-id]').filter({ hasText: 'Research Helper' }).first();
  const executionId = await row.getAttribute('data-execution-id');
  await row.getByRole('button', { name: 'Steer' }).first().click();
  await expect(page).toHaveURL(new RegExp(`execution=${executionId}`));
  await page.reload();
  const reins = page.getByRole('region', { name: 'Reins', exact: true });
  await expect(reins).toContainText(`execution ${executionId}`);
  await expect(page.locator(`li[data-execution-id="${executionId}"]`)).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(corral.errors).toEqual([]);
});

test('[TC-OBS-001-N] a link to an execution the run does not have targets nothing', async ({
  page,
  corral,
}) => {
  const runPath = await finishedRun(page, corral);
  await corral.open(`${runPath}?execution=exec_9999`);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await expect(page.getByRole('alert')).toContainText('exec_9999 is not part of this run');
  const reins = page.getByRole('region', { name: 'Reins', exact: true });
  await expect(reins.getByLabel('Instruction')).toHaveCount(0);
  await expect(reins).not.toContainText('execution exec_');
});
