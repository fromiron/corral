import { expect, type Locator, type Page, test } from '@playwright/test';
import { requestBox, startSession, teamFromTemplate } from './workbench.ts';

// Work sessions and input intents in the in-browser runtime.

async function sessionWithTeam(page: Page, delay: number) {
  await page.goto(`/?delay=${delay}`);
  await teamFromTemplate(page);
  await startSession(page, 'Compare two databases');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Compare two databases' }),
  ).toBeVisible();
}

const box = requestBox;
// The turns themselves: their flag and auto-choice lines carry `entry-…` test ids too.
const cards = (page: Page) => page.locator('article[data-testid^="entry-"]');
/**
 * A turn's run, which starts with its own status (read by assistive technology; the turn shows
 * it through its process line). Its steps carry statuses of their own further in.
 */
const status = (card: Locator, name: string) =>
  card.getByRole('region', { name: /^Run #\d+$/ }).filter({ hasText: new RegExp(`^${name}`) });

test('a follow-up continues the conversation in a new run; an IME Enter sends nothing', async ({
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
  await expect(status(cards(page).first(), 'Completed')).toBeVisible({
    timeout: 20_000,
  });

  // the next request carries the conversation; the first run is left as it was.
  await expect(box(page)).toHaveAccessibleDescription(
    'Send to: new run in this conversation · next request',
  );
  await box(page).fill('Now only for one writer');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(status(cards(page).nth(1), 'Completed')).toBeVisible({
    timeout: 20_000,
  });
  await expect(status(cards(page).first(), 'Completed')).toBeVisible();

  // a question about an answer is an ordinary message; there is no separate mode.
  await box(page).fill('/');
  await expect(page.getByRole('option', { name: /\/ask/ })).toHaveCount(0);
  await box(page).fill('Which one is simpler to back up?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).nth(2)).not.toContainText('Question about the result');
  await expect(status(cards(page).nth(2), 'Completed')).toBeVisible({
    timeout: 20_000,
  });
});

test('while a run works, a request waits in the queue until a person starts it', async ({
  page,
}) => {
  await sessionWithTeam(page, 1500);
  await box(page).fill('First request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  // Busy: Send joins the run (composer-flow.md "전송"); Alt+Enter sends a next request, which
  // waits behind it.
  await expect(box(page)).toHaveAccessibleDescription(/^Send to: Run #1 · .+ · Join$/);
  await expect(page.locator('[data-slot="composer-keys"]')).toContainText('Next');
  await box(page).fill('Then summarise it');
  await box(page).press('Alt+Enter');
  const queue = page.getByRole('region', { name: 'Queued next tasks' });
  await expect(queue).toContainText('Then summarise it');
  // Auto start is the server's; the browser demo has none, so a person starts it.
  await expect(queue.getByRole('switch')).toHaveCount(0);
  await expect(queue.getByRole('button', { name: 'Start now' })).toBeDisabled();
  await expect(status(cards(page).first(), 'Completed')).toBeVisible({
    timeout: 20_000,
  });
  await expect(queue.getByRole('button', { name: 'Start now' })).toBeEnabled();
  await queue.getByRole('button', { name: 'Start now' }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).nth(1)).toContainText('Then summarise it');
  await expect(queue).toHaveCount(0);
});
