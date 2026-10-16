import { expect, type Page, test } from '@playwright/test';

// Work sessions and input intents (CR-011, roadmap 23–24; WBTST-004) in the in-browser runtime.

async function sessionWithTeam(page: Page, delay: number) {
  await page.goto(`/?delay=${delay}`);
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Use this template' })
    .click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Purpose').fill('Compare two databases');
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  await expect(page.getByRole('heading', { level: 2, name: 'Compare two databases' })).toBeVisible();
}

const box = (page: Page) => page.getByRole('textbox', { name: 'Request' });
const cards = (page: Page) => page.locator('[data-testid^="entry-"]');

test('[WBTST-004] a follow-up starts a new run from the last result; an IME Enter sends nothing', async ({
  page,
}) => {
  await sessionWithTeam(page, 50);
  await box(page).fill('Compare SQLite and Postgres');
  await box(page).dispatchEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    isComposing: true,
    keyCode: 229,
    bubbles: true,
  });
  await expect(cards(page)).toHaveCount(0);
  await box(page).press('Control+Enter');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Started');
  await expect(cards(page).first().getByText('Succeeded')).toBeVisible({ timeout: 20_000 });

  // The next request starts from that result; the first run is left as it was.
  await expect(page.getByText(/^Starts from .+ v\d+$/)).toBeVisible();
  await box(page).fill('Now only for one writer');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).nth(1).getByText('Succeeded')).toBeVisible({ timeout: 20_000 });
  await expect(cards(page).first().getByText('Succeeded')).toBeVisible();

  // A question about the result is its own run.
  await page.getByText('Question about the result', { exact: true }).click();
  await box(page).fill('Which one is simpler to back up?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).nth(2)).toContainText('Question about the result');
  await expect(cards(page).nth(2).getByText('Succeeded')).toBeVisible({ timeout: 20_000 });
});

test('[WBTST-004] while a run works, a request waits in the queue until a person starts it', async ({
  page,
}) => {
  await sessionWithTeam(page, 1500);
  await box(page).fill('First request');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(cards(page)).toHaveCount(1);
  // Busy: continuing is not offered; queueing is.
  await expect(page.getByText('Continue in this session', { exact: true })).toHaveCount(0);
  await page.getByText('Queue as next task', { exact: true }).click();
  await box(page).fill('Then summarise it');
  await page.getByRole('button', { name: 'Send' }).click();
  const queue = page.getByRole('heading', { name: 'Queued next tasks' }).locator('..');
  await expect(queue).toContainText('Then summarise it');
  await expect(queue.getByRole('button', { name: 'Start now' })).toBeDisabled();
  await expect(cards(page).first().getByText('Succeeded')).toBeVisible({ timeout: 20_000 });
  await expect(queue.getByRole('button', { name: 'Start now' })).toBeEnabled();
  await queue.getByRole('button', { name: 'Start now' }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).nth(1)).toContainText('Then summarise it');
  await expect(page.getByRole('heading', { name: 'Queued next tasks' })).toHaveCount(0);
});
