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

test('[TC-WIDGET-001-H] SURFACE-01 SCROLL-02 summary stays in the right upper card outside the conversation scroll', async ({
  page,
}) => {
  await completedConversation(page);
  const timeline = page.getByTestId('chat-timeline');
  const widgets = page.getByTestId('session-summary-card');
  await expect(widgets).toBeVisible();
  expect(
    await widgets.evaluate((element) => Boolean(element.closest('[data-testid="chat-timeline"]'))),
  ).toBe(false);
  const cardBounds = await widgets.boundingBox();
  const timelineBounds = await timeline.boundingBox();
  if (!cardBounds || !timelineBounds)
    throw new Error('The summary and conversation must be visible');
  expect(cardBounds.x).toBeGreaterThanOrEqual(timelineBounds.x + timelineBounds.width);
  expect(cardBounds.width).toBeGreaterThanOrEqual(280);
  expect(cardBounds.width).toBeLessThanOrEqual(320);
  expect(cardBounds.y).toBeLessThan(timelineBounds.y + 80);
  const initialTop = (await widgets.boundingBox())!.y;
  await timeline.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 3;
  });
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  await expect(widgets).toBeVisible();
  expect((await widgets.boundingBox())!.y).toBe(initialTop);

  const anchor = await timeline.evaluate((box) => {
    const top = box.getBoundingClientRect().top;
    const row = [...box.querySelectorAll<HTMLElement>('[data-chat-item]')].find(
      (item) => item.getBoundingClientRect().bottom > top,
    )!;
    return { id: row.dataset.chatItem!, offset: row.getBoundingClientRect().top - top };
  });
  await requestBox(page).fill('A draft that must keep its DOM and selection');
  await requestBox(page).evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(8, 13);
    element.dataset.identity = 'retained';
  });
  await page.setViewportSize({ width: 1280, height: 670 });
  await expect
    .poll(() =>
      timeline
        .locator(`[data-chat-item="${anchor.id}"]`)
        .evaluate(
          (row, offset) =>
            Math.abs(
              row.getBoundingClientRect().top -
                row.closest('[data-testid="chat-timeline"]')!.getBoundingClientRect().top -
                offset,
            ),
          anchor.offset,
        ),
    )
    .toBeLessThan(4);
  await expect(requestBox(page)).toHaveAttribute('data-identity', 'retained');
  expect(
    await requestBox(page).evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([8, 13]);
});

test('[TC-WIDGET-001-H] SURFACE-02 narrow summary stays accessible and opening details selects its area', async ({
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
  await page.getByRole('banner').getByRole('button', { name: 'Show the panel' }).click();
  await expect(page.getByRole('tab', { name: 'Work panel', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Execution', exact: true }).click();
  await expect(page.getByTestId('compact-run')).toBeVisible();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await expect(requestBox(page)).toBeVisible();
});

test('[TC-WIDGET-001-H] RESULT-03 default execution panel offers its actual results', async ({
  page,
}) => {
  await completedConversation(page);
  await panelTab(page, 'Execution');
  const compact = page.getByTestId('compact-run');
  const results = compact.getByRole('list', { name: 'Results', exact: true });
  await expect(results).toBeVisible();
  await expect(results.getByRole('button')).not.toHaveCount(0);
  await results.getByRole('button').first().click();
  await expect(compact.getByTestId('result-body')).toBeVisible();
});

test('[TC-WIDGET-001-H] ACTION-01 opens one scoped response host and keeps later typing focus', async ({
  page,
}) => {
  await page.goto('/?delay=50');
  await teamFromTemplate(page, 'Research team');
  await startSession(page, 'Review this request');
  await requestBox(page).press('Control+Enter');
  const action = page.getByTestId('action-required');
  await expect(action).toBeVisible({ timeout: 20_000 });
  await action.getByRole('link').click();
  const response = page.locator('[data-run-response]');
  await expect(response).toBeFocused();
  await expect(page.getByRole('button', { name: 'Continue with this version' })).toHaveCount(1);
  await response.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect(
    page.getByTestId('compact-run').getByRole('article', { name: 'draft v2' }),
  ).toBeVisible();
  await response.getByRole('button', { name: 'review v2', exact: true }).click();
  await expect(
    page
      .getByTestId('compact-run')
      .getByRole('region', { name: 'review · Version 2', exact: true }),
  ).toBeVisible();
  await requestBox(page).fill('Keep typing while the run continues');
  await expect(requestBox(page)).toBeFocused();
  // A later decision in the same run must not move focus back from the composer.
  await page.getByRole('button', { name: 'Continue with this version' }).click();
  await requestBox(page).focus();
  await expect(page.getByRole('button', { name: 'Confirm as final result' })).toBeVisible();
  await expect(requestBox(page)).toBeFocused();
});
