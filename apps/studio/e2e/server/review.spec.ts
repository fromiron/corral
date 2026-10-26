import { join } from 'node:path';
import { expect, test } from './harness.ts';

const EXAMPLES = join(import.meta.dirname, '..', '..', '..', '..', 'examples');

test('a review loop revises the draft, and two approvals of exact versions finish the run', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles([
      join(EXAMPLES, 'research-team.corral.json'),
      join(EXAMPLES, 'research-team.layout.json'),
    ]);
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const decision = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' });
  await expect(decision).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page.getByTestId('run-status')).toContainText('Waiting for you');
  // The decision is about draft@2 and the review that passed it, judged by the run's criteria.
  const card = page.locator('[data-testid^="approval-"]');
  await expect(card).toContainText('근거 자료의 출처를 명시한다.');
  await card.getByRole('button', { name: 'draft v2', exact: true }).click();
  const viewer = page.getByTestId('artifact-viewer');
  await expect(viewer).toContainText('draft · Version 2');
  await expect(viewer).toContainText('Revises');
  await viewer.getByRole('button', { name: /Compare with/ }).click();
  await expect(viewer.locator('[data-diff="added"]').first()).toBeVisible();
  await expect(viewer.locator('[data-diff="removed"]').first()).toBeVisible();

  // Follow the lineage back: draft@1, and the review of it asked for a revision.
  await viewer.getByRole('button', { name: 'Hide comparison' }).click();
  const parentId = await viewer.locator('dt:has-text("Revises") + dd button').textContent();
  await viewer.locator('dt:has-text("Made from") + dd button').last().click();
  await expect(page.getByTestId('review-verdict')).toContainText('Revise');
  await expect(page.getByTestId('review-verdict')).toContainText(parentId ?? 'missing');

  await card.getByRole('button', { name: 'Continue with this version' }).click();
  const final = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Final output' });
  await expect(final).toBeVisible();
  await final.getByRole('button', { name: 'Confirm as final result' }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await expect(page.getByTestId('run-output')).toBeVisible();
  expect(corral.errors).toEqual([]);
});
