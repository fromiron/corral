import { join } from 'node:path';
import { openResult, startTestRun } from '../workbench.ts';
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
    .setInputFiles([join(EXAMPLES, 'research-team.corral.json')]);
  await expect(page).toHaveURL(/\/edit$/);
  await startTestRun(page);
  const decision = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' });
  await expect(decision).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page.getByTestId('run-status')).toContainText('Waiting for you');
  // The decision is about draft@2 and the review that passed it, judged by the run's criteria.
  // What the run waits on opens from the run header.
  const waiting = page.getByTestId('run-needs-you');
  const needsYou = async () => {
    if (!(await waiting.isVisible()))
      await page.getByTestId('run-respond').click();
    return waiting;
  };
  const card = (await needsYou()).locator('[data-testid^="approval-"]');
  await expect(card).toContainText('근거 자료의 출처를 명시한다.');
  await card.getByRole('button', { name: 'draft v2', exact: true }).click();
  const viewer = page.getByTestId('artifact-viewer');
  await expect(viewer).toContainText('draft · Version 2');

  // The lineage names what draft@2 was made from: draft@1 and the review that asked for a
  // revision. Past versions show as relationships only; their bodies do not open
  // (execution-monitor.md).
  const [started] = corral.server.coordinator.listRuns();
  if (!started) throw new Error('Expected the review run');
  const artifacts = Object.values(
    corral.server.coordinator.getSnapshot(started.runId).projection.artifacts,
  );
  const version = (name: string, no: number) =>
    artifacts.find((artifact) => artifact.name === name && artifact.version === no);
  const firstDraft = version('draft', 2)?.parentVersionId;
  const firstReview = version('review', 1)?.artifactVersionId;
  if (!firstDraft || !firstReview) throw new Error('Expected a revised draft and its review');
  const madeFrom = viewer.locator('dt:has-text("Made from") + dd');
  await expect(madeFrom).toContainText(firstDraft);
  await expect(madeFrom).toContainText(firstReview);
  await expect(madeFrom.getByRole('button', { name: firstDraft })).toHaveCount(0);

  await (await needsYou())
    .locator('[data-testid^="approval-"]')
    .getByRole('button', { name: 'Continue with this version' })
    .click();
  await expect(page.getByTestId('run-respond')).toBeVisible();
  const final = (await needsYou())
    .locator('[data-testid^="approval-"]')
    .filter({ hasText: 'Final output' });
  await expect(final).toBeVisible();
  await final.getByRole('button', { name: 'Confirm as final result' }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await openResult(page, /^draft v2/);
  const results = page.getByTestId('run-results');
  await expect(results.getByRole('article', { name: 'draft v2', exact: true })).toBeVisible();
  const run = corral.server.coordinator.listRuns()[0];
  if (!run) throw new Error('Expected the completed review run');
  const finalId = corral.server.coordinator.getSnapshot(run.runId).projection.output
    ?.artifactVersionIds[0];
  if (!finalId) throw new Error('Expected a confirmed final output');
  const finalText = corral.server.coordinator.getArtifactText(run.runId, finalId);
  if (!finalText) throw new Error('Expected confirmed output text');
  await results.getByRole('radio', { name: 'Source', exact: true }).click();
  await expect(results.getByTestId('result-body')).toHaveText(finalText);
  await expect(results.getByRole('article', { name: 'draft v2', exact: true })).toContainText(
    'Submitted',
  );
  expect(corral.errors).toEqual([]);
});
