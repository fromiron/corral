import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, type Harness, test } from '../server/harness.ts';
import { newConversation } from '../workbench.ts';
import { waitForStill } from './probe.ts';

// The windowed timeline under a reader (docs/specs/features/composer-flow.md, "튐 없는 본문"
// rules 5 and 6; docs/specs/chat-widgets-contract.md SCROLL-02 and SCROLL-03): a focused row
// kept mounted away from the rows in view leaves the list's height as it was, and the keys that
// move the conversation reach where they say, however many rows it has.

/** Requests of varied height, some far under and some over the list's estimate of a row. */
function seed(corral: Harness, sessionId: string, count: number) {
  const require = createRequire(
    join(import.meta.dirname, '..', '..', '..', 'server', 'package.json'),
  );
  const Database = require('better-sqlite3');
  const db = new Database(join(corral.workspace, '.corral', 'corral.db'));
  try {
    const entries = Array.from({ length: count }, (_, index) => ({
      entryId: `entry_window${index}`,
      intent: 'next',
      state: 'refused',
      text: `Earlier request ${index + 1}. ${'This message is long enough to wrap over several lines of the conversation column. '.repeat(((index * 7) % 13) + 1)}`,
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
}

async function open(page: Page, corral: Harness, count: number) {
  await corral.open('/');
  await newConversation(page);
  await expect(page).toHaveURL(/\/sessions\/session_/);
  seed(corral, new URL(page.url()).pathname.split('/').at(-1) as string, count);
  await page.reload();
  await expect(timeline(page)).toContainText(`Earlier request ${count}.`);
  await waitForStill(page);
}

const timeline = (page: Page) => page.getByTestId('chat-timeline');
const latest = (page: Page) => page.getByRole('button', { name: 'Jump to latest', exact: true });

/** Where the view is: its offsets and the rows it has mounted and shows. */
const place = (page: Page) =>
  timeline(page).evaluate((box) => {
    const edge = box.getBoundingClientRect();
    const face = document.querySelector<HTMLElement>('[data-testid="chat-composer"]');
    const floor = face ? face.getBoundingClientRect().top : edge.bottom;
    const rows = [...box.querySelectorAll<HTMLElement>('[data-chat-item]')];
    const shown = rows
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > edge.top + 1 && rect.top < floor - 1;
      })
      .map((row) => Number(row.dataset.index));
    return {
      top: box.scrollTop,
      height: box.scrollHeight,
      gap: box.scrollHeight - box.scrollTop - box.clientHeight,
      // What the composer leaves of the timeline in view: the page a key moves by.
      visible: floor - edge.top,
      shown,
      // Each mounted row's offset from the timeline's top edge.
      offsets: Object.fromEntries(
        rows.map((row) => [row.dataset.index, row.getBoundingClientRect().top - edge.top]),
      ) as Record<string, number>,
      latestMounted: box.querySelector('[data-latest]') !== null,
    };
  });

/** Wheels in steps in the margin beside the column, until the end or the top, or `limit`. */
async function wheel(page: Page, deltaY: number, limit: number) {
  await timeline(page).hover({ position: { x: 16, y: 200 } });
  const seen = [await place(page)];
  for (let step = 0; step < limit; step += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(160);
    const at = await place(page);
    seen.push(at);
    if (deltaY > 0 ? at.gap < 1 : at.top <= 0) break;
  }
  await waitForStill(page);
  seen.push(await place(page));
  return seen;
}

/**
 * How far the rows moved on screen between two places, read from a row mounted in both: rows
 * measured on the way change the offset by what they add above, not what the reader sees.
 */
function moved(
  before: { offsets: Record<string, number> },
  after: { offsets: Record<string, number> },
) {
  const id = Object.keys(before.offsets).find((key) => key in after.offsets);
  if (id === undefined) throw new Error('No row mounted before and after');
  return (before.offsets[id] as number) - (after.offsets[id] as number);
}

const heightChange = (seen: { height: number }[]) =>
  Math.max(...seen.map((at) => Math.abs(at.height - (seen[0]?.height ?? 0))));

test('a focused row kept mounted away from the rows in view leaves the list’s height', async ({
  page,
  corral,
}) => {
  test.setTimeout(180_000);
  const count = 301;
  await open(page, corral, count);
  // Up to a message 61 rows above the end; every row passed on the way is measured.
  const target = count - 61;
  const row = timeline(page).locator(`[data-chat-item="entry_window${target}"]`);
  await timeline(page).hover({ position: { x: 16, y: 200 } });
  for (let step = 0; step < 200; step += 1) {
    const shown = (await place(page)).shown;
    if (shown.includes(target) && shown.includes(target + 1)) break;
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(80);
  }
  await waitForStill(page);
  const copy = row.getByRole('button', { name: 'Copy message', exact: true });
  // The message's actions show on hover.
  await copy.hover({ force: true });
  await copy.click();
  await expect(copy).toBeFocused();
  // Down to the end with the focus left on that message.
  const down = await wheel(page, 300, 120);
  const end = down.at(-1);
  expect(end?.gap).toBeLessThanOrEqual(1);
  expect(end?.latestMounted).toBe(true);
  expect(end?.shown).toContain(count - 1);
  expect(heightChange(down)).toBeLessThanOrEqual(2);
  await expect(copy).toBeFocused();
  await expect(latest(page)).toHaveCount(0);
  // The focus on the last message, and up again over the rows already measured.
  const last = timeline(page)
    .locator(`[data-chat-item="entry_window${count - 1}"]`)
    .getByRole('button', { name: 'Copy message', exact: true });
  await last.focus();
  const up = await wheel(page, -300, 25);
  expect(heightChange(up)).toBeLessThanOrEqual(2);
  expect(up.at(-1)?.shown.length).toBeGreaterThan(0);
  await expect(last).toBeFocused();
  await expect(latest(page)).toBeVisible();
  expect(corral.errors).toEqual([]);
});

for (const count of [30, 300]) {
  test(`Home, End, PageUp and PageDown on the timeline reach where they say (${count} rows)`, async ({
    page,
    corral,
  }) => {
    test.setTimeout(180_000);
    await open(page, corral, count);
    await timeline(page).focus();
    const settle = async () => {
      await page.waitForTimeout(400);
      await waitForStill(page);
      return place(page);
    };
    await page.keyboard.press('Home');
    const top = await settle();
    expect(top.top).toBeLessThanOrEqual(1);
    expect(top.shown).toContain(0);
    await expect(latest(page)).toBeVisible();
    // A page down from the first row moves by close to the visible height (the browser's own
    // step: seven eighths of the area above the composer).
    await page.keyboard.press('PageDown');
    const down = await settle();
    const page1 = moved(top, down);
    expect(page1).toBeGreaterThanOrEqual(down.visible * 0.85);
    expect(page1).toBeLessThanOrEqual(down.visible);
    await page.keyboard.press('End');
    const end = await settle();
    expect(end.gap).toBeLessThanOrEqual(1);
    expect(end.shown).toContain(count - 1);
    await expect(latest(page)).toHaveCount(0);
    await page.keyboard.press('PageUp');
    const up = await settle();
    const page2 = -moved(end, up);
    expect(page2).toBeGreaterThanOrEqual(up.visible * 0.85);
    expect(page2).toBeLessThanOrEqual(up.visible);
    // Home from the end of a long history still reaches the first row.
    await page.keyboard.press('End');
    await settle();
    await page.keyboard.press('Home');
    const again = await settle();
    expect(again.top).toBeLessThanOrEqual(1);
    expect(again.shown).toContain(0);
    expect(corral.errors).toEqual([]);
  });
}
