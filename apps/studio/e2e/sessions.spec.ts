import { expect, type Page, test } from '@playwright/test';
import { requestBox, slash, startSession, teamFromTemplate } from './workbench.ts';

// Work sessions and input intents (CR-011, roadmap 23–24; WBTST-004) in the in-browser runtime.

async function sessionWithTeam(page: Page, delay: number) {
  await page.goto(`/?delay=${delay}`);
  await teamFromTemplate(page);
  await startSession(page, 'Compare two databases');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Compare two databases' }),
  ).toBeVisible();
}

const box = requestBox;
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

  // A question about the result is its own run, chosen with a / command.
  await slash(page, 'ask');
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
  await box(page).fill('/');
  await expect(page.getByRole('option', { name: /\/next/ })).toHaveCount(0);
  await slash(page, 'queue');
  await box(page).fill('Then summarise it');
  await page.getByRole('button', { name: 'Send' }).click();
  const queue = page.getByRole('region', { name: 'Queued next tasks' });
  await expect(queue).toContainText('Then summarise it');
  await expect(queue.getByRole('button', { name: 'Start now' })).toBeDisabled();
  await expect(cards(page).first().getByText('Succeeded')).toBeVisible({ timeout: 20_000 });
  await expect(queue.getByRole('button', { name: 'Start now' })).toBeEnabled();
  await queue.getByRole('button', { name: 'Start now' }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).nth(1)).toContainText('Then summarise it');
  await expect(queue).toHaveCount(0);
});
