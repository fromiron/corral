import { join } from 'node:path';
import { startTestRun, teamCanvas } from '../workbench.ts';
import { expect, test } from './harness.ts';

const EXAMPLES = join(import.meta.dirname, '..', '..', '..', '..', 'examples');

test('one run shows two delegated helpers and a question answered by a new responder', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles([join(EXAMPLES, 'research-brief.corral.json')]);
  await expect(page).toHaveURL(/\/edit$/);
  // Call links are named on the canvas by what they let the caller do.
  await expect(
    teamCanvas(page)
      .locator('[data-edge]')
      .filter({ hasText: /^(delegates|asks)$/ }),
  ).toHaveCount(2);
  await startTestRun(page);
  await expect(page.getByTestId('run-output')).toContainText('answer:', { timeout: 15_000 });

  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  const monitor = page.getByTestId('run-monitor');
  // Two helper executions in the work flow, delegated by Research.
  await monitor.getByRole('tab', { name: 'Work flow', exact: true }).click();
  await expect(
    monitor.getByTestId('run-work-flow').getByRole('button', { name: /^Research Helper · exec_/ }),
  ).toHaveCount(2);

  // The question: from the Writer to a responder execution of its own, answered.
  await monitor.getByRole('button', { name: 'Run info', exact: true }).click();
  const details = monitor.getByRole('tabpanel', { name: 'Overview', exact: true });
  await details.getByRole('button', { name: /^Questions/ }).click();
  const question = page.locator('[data-testid^="question-"]');
  await expect(question).toHaveCount(1);
  await expect(question).toContainText('Writer');
  await expect(question).toContainText('Answered');
  const responderLink = question.getByRole('link', { name: 'Source Responder' });
  const href = await responderLink.getAttribute('href');
  await expect(page.locator(href ?? '#none')).toContainText('Source Responder');

  // A helper's submitted version opens from the Task Board, rendered safely.
  await details.getByRole('button', { name: /^Tasks/ }).click();
  const helperTask = details
    .locator('[data-testid^="task-"]')
    .filter({ hasText: 'Research Helper' })
    .first();
  await helperTask.getByRole('button').first().click();
  await expect(page.getByTestId('artifact-viewer')).toContainText('notes-part');
  await expect(page.getByTestId('artifact-viewer')).toContainText('submitted');
  expect(corral.errors).toEqual([]);
});
