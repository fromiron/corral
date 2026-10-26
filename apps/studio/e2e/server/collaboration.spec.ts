import { join } from 'node:path';
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
    .setInputFiles([
      join(EXAMPLES, 'research-brief.corral.json'),
      join(EXAMPLES, 'research-brief.layout.json'),
    ]);
  await expect(page).toHaveURL(/\/edit$/);
  await expect(page.locator('.corral-call-link')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toContainText('answer:', { timeout: 15_000 });

  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  const monitor = page.getByTestId('run-monitor');
  await monitor.getByRole('button', { name: 'Executions', exact: true }).click();

  // Two helper executions nested under Research in the call tree.
  const research = page.locator('[data-execution-id]').filter({ hasText: 'Research ·' }).first();
  await expect(
    research.locator('[data-execution-id]').filter({ hasText: 'Research Helper' }),
  ).toHaveCount(2);

  // The question: from the Writer to a responder execution of its own, answered.
  await monitor.getByRole('button', { name: 'Details', exact: true }).click();
  const details = monitor.getByRole('tabpanel', { name: 'Overview', exact: true });
  const question = page.locator('[data-testid^="question-"]');
  await expect(question).toHaveCount(1);
  await expect(question).toContainText('Writer');
  await expect(question).toContainText('Answered');
  const responderLink = question.getByRole('link', { name: 'Source Responder' });
  const href = await responderLink.getAttribute('href');
  await expect(page.locator(href ?? '#none')).toContainText('Source Responder');

  // A helper's submitted version opens from the Task Board, rendered safely.
  await expect(details.getByRole('region', { name: 'Tasks', exact: true })).toBeVisible();
  const helperTask = page
    .locator('[data-testid^="task-"]')
    .filter({ hasText: 'Research Helper' })
    .first();
  await helperTask.getByRole('button').first().click();
  await expect(page.getByTestId('artifact-viewer')).toContainText('notes-part');
  await expect(page.getByTestId('artifact-viewer')).toContainText('submitted');
  expect(corral.errors).toEqual([]);
});
