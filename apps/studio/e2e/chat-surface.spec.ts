import { expect, type Page, test } from '@playwright/test';
import { panelTab, requestBox, startSession, teamFromTemplate } from './workbench.ts';

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
  await expect(page.getByTestId('chat-timeline').getByText('Succeeded')).toBeVisible();
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
  await panelTab(page, 'Execution history');
  await expect(page.getByRole('tab', { name: 'Execution history', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('run-monitor')).toBeVisible();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await expect(requestBox(page)).toBeVisible();
});

test('RESULT-03 default execution panel offers its actual results', async ({ page }) => {
  await completedConversation(page);
  await panelTab(page, 'Execution history');
  const monitor = page.getByTestId('run-monitor');
  await expect(monitor.getByRole('tab', { name: 'Graph', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await monitor.getByRole('button', { name: 'Results', exact: true }).click();
  const results = monitor.getByRole('navigation', { name: 'Results', exact: true });
  await expect(results).toBeVisible();
  await expect(results.getByRole('button')).not.toHaveCount(0);
  await results.getByRole('button').first().click();
  await expect(monitor.getByTestId('result-body')).toBeVisible();
});
