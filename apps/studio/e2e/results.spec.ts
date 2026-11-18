import { expect, test } from '@playwright/test';
import { approvalResearchTeam } from '../src/demo/testing/approval-team.ts';
import { importTeam, showResults, startTestRun } from './workbench.ts';

// The Results view on the in-browser research team, with its approvals put back so the run
// waits for a person. Browser runs live in the page's worker, so the Run page is reached
// through the app's link.

test('a cancelled run keeps what it made as a partial result', async ({ page }) => {
  await importTeam(page, approvalResearchTeam().definition, 150);
  await startTestRun(page);
  // The decision waits for a person after the drafts and reviews are written.
  await expect(
    page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' }),
  ).toBeVisible({ timeout: 20_000 });
  // The approval's reject may carry the same name: the stop is the run controls' own. Its
  // confirmation stands in the controls under it, Keep running first and focused.
  const controls = page.getByRole('region', { name: 'Run controls', exact: true });
  const stop = controls.getByRole('button', { name: 'Stop the run', exact: true });
  await stop.click();
  await expect(controls.getByRole('status')).toContainText('The stop has not been sent.');
  await expect(controls.getByRole('button', { name: 'Keep running', exact: true })).toBeFocused();
  await stop.last().click();
  await expect(page.getByTestId('run-status')).toContainText('Cancelled', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Open run page' }).click();

  await expect(page.getByRole('group', { name: 'Run graph', exact: true })).toBeVisible();
  // What it made before it stopped is offered as partial, and opens as the artifact it is. The
  // Results view is a table whose groups of rows are named (execution-monitor.md: "결과 보기는
  // 결과 버전마다 이름·출처 실행·버전을 보이고 기존 결과 읽기로 연다").
  const partial = (await showResults(page))
    .getByRole('rowgroup', { name: 'Partial results', exact: true })
    .getByRole('button')
    .first();
  await partial.click();
  await expect(page.getByTestId('run-document').getByTestId('artifact-viewer')).toBeVisible();
});
