import { expect, type Page, test } from '@playwright/test';
import {
  closePanel,
  lastRunSucceeded,
  openPanelTab,
  openResult,
  panelContent,
  panelTabNamed,
  requestBox,
  startSession,
  teamFromTemplate,
} from './workbench.ts';

async function completedConversation(page: Page) {
  await page.goto('/?delay=50');
  await teamFromTemplate(page);
  await startSession(page, 'Chat surface regression');
  const input = requestBox(page);
  await input.fill(
    Array.from(
      { length: 70 },
      (_, index) =>
        `Requirement ${index + 1}: preserve the selected conversation and its controls.`,
    ).join('\n'),
  );
  await input.press('Control+Enter');
  await expect(lastRunSucceeded(page)).toBeVisible({ timeout: 20_000 });
}

test('SURFACE-02 narrow summary stays accessible and opening details selects its area', async ({
  page,
}) => {
  await completedConversation(page);
  await page.setViewportSize({ width: 760, height: 800 });
  await expect(page.getByTestId('session-summary-slot')).toBeHidden();
  const trigger = page.getByTestId('session-summary-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByTestId('session-summary-popup')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  // No room beside the conversation at this width: the run's tab opens in a drawer over it.
  await openPanelTab(page, 'Runs');
  await expect(panelTabNamed(page, 'Run #1')).toHaveAttribute('aria-selected', 'true');
  await expect(panelContent(page, 'Run #1').getByTestId('run-monitor')).toBeVisible();
  await closePanel(page);
  await expect(requestBox(page)).toBeVisible();
});

test('RESULT-03 default execution panel offers its actual results', async ({ page }) => {
  await completedConversation(page);
  await openPanelTab(page, 'Runs');
  const monitor = panelContent(page, 'Run #1').getByTestId('run-monitor');
  await expect(monitor.getByRole('group', { name: 'Run graph', exact: true })).toBeVisible();
  await openResult(page);
  const results = monitor.getByRole('navigation', { name: 'Results', exact: true });
  await expect(results).toBeVisible();
  await expect(results.getByRole('button')).not.toHaveCount(0);
  await results.getByRole('button').first().click();
  await expect(monitor.getByTestId('result-body')).toBeVisible();
});
