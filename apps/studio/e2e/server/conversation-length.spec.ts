import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from './harness.ts';

test('[TC-CONTINUITY-001-H] [TC-CHAT-002-H] [TC-CHAT-002-N] a long conversation restores the request anchor without mounting the whole history', async ({
  page,
  corral,
}) => {
  test.setTimeout(90_000);
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const url = page.url();
  const sessionId = new URL(url).pathname.split('/').at(-1)!;
  const require = createRequire(
    join(import.meta.dirname, '..', '..', '..', 'server', 'package.json'),
  );
  const Database = require('better-sqlite3');
  const db = new Database(join(corral.workspace, '.corral', 'corral.db'));
  try {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      entryId: `entry_fixture${i}`,
      intent: 'explain',
      state: 'sent',
      text: `Request ${i} 한국어 日本語\n${'Some saved conversation content. '.repeat((i % 4) + 1)}`,
      createdAt: new Date().toISOString(),
      runId: null,
      executionId: null,
      detail: null,
      commandId: null,
    }));
    db.prepare(
      'UPDATE work_sessions SET entries_json = ?, revision = revision + 1 WHERE id = ?',
    ).run(JSON.stringify(entries), sessionId);
  } finally {
    db.close();
  }
  await page.reload();
  const timeline = page.getByTestId('chat-timeline');
  await expect(timeline).toContainText('Request 999');
  await expect.poll(() => timeline.locator('[data-testid^="entry-"]').count()).toBeLessThan(40);
  await timeline.evaluate((box) => {
    box.scrollTop = box.scrollHeight / 2;
  });
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  const anchor = await timeline.evaluate((box) => {
    const top = box.getBoundingClientRect().top;
    const item = [...box.querySelectorAll<HTMLElement>('[data-chat-item]')].find(
      (row) => row.getBoundingClientRect().bottom > top,
    )!;
    return { id: item.dataset.chatItem!, offset: item.getBoundingClientRect().top - top };
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings/);
  await page.goto(url);
  await expect.poll(() => timeline.locator(`[data-chat-item="${anchor.id}"]`).count()).toBe(1);
  await expect
    .poll(async () =>
      Math.abs(
        (await timeline
          .locator(`[data-chat-item="${anchor.id}"]`)
          .evaluate(
            (row) =>
              row.getBoundingClientRect().top -
              row.closest('[data-testid="chat-timeline"]')!.getBoundingClientRect().top,
          )) - anchor.offset,
      ),
    )
    .toBeLessThan(4);
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(timeline).toContainText('Request 999');
  await page.getByRole('button', { name: 'Search sessions and results', exact: true }).click();
  await expect(page.getByRole('dialog').locator('[data-slot="dialog-header"]')).toHaveCSS(
    'padding-left',
    '24px',
  );
  await expect(page.getByRole('dialog').locator('[data-slot="dialog-panel"]')).toHaveCSS(
    'padding-right',
    '24px',
  );
  const search = page.getByRole('dialog');
  await search.getByRole('textbox', { name: 'Search text' }).fill('Request 123 한국어');
  await expect(search).toContainText('0 matches');
  await search.getByRole('checkbox', { name: 'Include private messages and results' }).check();
  await expect(search).toContainText('1 matches');
  await search.getByRole('link').filter({ hasText: 'request 123' }).click();
  await expect(timeline.locator('[data-chat-item="entry_fixture123"]')).toBeVisible();
  const selectedUrl = page.url();
  const other = await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    return (
      await (
        await fetch('/api/v1/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify({ projectId: 'default', title: 'Second tab' }),
        })
      ).json()
    ).session.sessionId as string;
  });
  await page.goto(`${corral.server.url}/sessions/${other}`);
  const tabs = page.getByRole('navigation', { name: 'Session tabs' });
  await expect(tabs.getByRole('link')).toHaveCount(2);
  await tabs.getByRole('link').first().click();
  await expect(page).toHaveURL(selectedUrl);
  await expect(timeline.locator('[data-chat-item="entry_fixture123"]')).toBeVisible();
  await tabs.getByRole('button', { name: 'Close Second tab tab' }).click();
  await expect(tabs.getByRole('link')).toHaveCount(1);
  expect(corral.errors).toEqual([]);
});
