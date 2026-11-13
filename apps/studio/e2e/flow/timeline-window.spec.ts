import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fauxAssistantMessage } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, type Harness, test } from '../server/harness.ts';
import { newConversation, requestBox, runGoing } from '../workbench.ts';
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
    // With Ctrl as well, the same.
    await page.keyboard.press('Control+End');
    const end2 = await settle();
    expect(end2.gap).toBeLessThanOrEqual(1);
    await page.keyboard.press('Control+Home');
    const top2 = await settle();
    expect(top2.top).toBeLessThanOrEqual(1);
    expect(top2.shown).toContain(0);
    expect(corral.errors).toEqual([]);
  });
}

/** A reply far taller than the view, as a run shows it once its record has loaded. */
const TALL_REPLY = (sentences: number) =>
  [
    '## What I found',
    '',
    'The slow path is the session lookup, which runs once per row instead of once per request.',
    '',
    '1. **Latency** grows with the number of rows on the page.',
    '2. The cache is never warm, because each lookup uses a fresh key.',
    '',
    '```ts',
    'export async function loadSession(id: string) {',
    '  return cache.get(id) ?? (await db.sessions.findUnique({ where: { id } }));',
    '}',
    '```',
    '',
    '| Step | Before | After |',
    '| --- | --- | --- |',
    '| Lookup | 240 ms | 12 ms |',
    '',
    'The reply keeps growing while it streams in, one sentence after another. '.repeat(sentences),
  ].join('\n');

/**
 * Counts what the page writes to the timeline's offset and how often its mounted rows change,
 * frame by frame, and keeps the smallest distance to the end each frame showed.
 */
const record = (page: Page) =>
  timeline(page).evaluate((box) => {
    const own = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollTop',
    ) as PropertyDescriptor;
    const state = { writes: 0, sets: new Set<string>(), minGap: Number.POSITIVE_INFINITY };
    (window as unknown as { __timeline: typeof state }).__timeline = state;
    Object.defineProperty(box, 'scrollTop', {
      configurable: true,
      get() {
        return own.get?.call(this);
      },
      set(value: number) {
        const before = own.get?.call(this) as number;
        own.set?.call(this, value);
        if (Math.abs((own.get?.call(this) as number) - before) > 0.01) state.writes += 1;
      },
    });
    const frame = () => {
      state.sets.add(
        [...box.querySelectorAll<HTMLElement>('[data-chat-item]')]
          .map((row) => row.dataset.index)
          .join(','),
      );
      state.minGap = Math.min(state.minGap, box.scrollHeight - box.scrollTop - box.clientHeight);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

/** Starts a new count, and returns the one before it. */
const recorded = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as {
        __timeline: { writes: number; sets: Set<string>; minGap: number };
      }
    ).__timeline;
    const out = { writes: state.writes, sets: state.sets.size, minGap: state.minGap };
    state.writes = 0;
    state.sets = new Set();
    state.minGap = Number.POSITIVE_INFINITY;
    return out;
  });

/**
 * Wheels up by 300 `count` times, `wait` apart: each wheel takes the reader 300 further from the
 * end, the rows they read move by that alone, and no frame between two wheels shows the view
 * pulled back toward the end. Rows growing above move the offset and the height together, so
 * the distance to the end and the rows on screen say how far the reader went, not the offset.
 * While a reply streams, the end itself moves away as well.
 */
async function wheelUpFromEnd(page: Page, count: number, wait: number, streaming: boolean) {
  await timeline(page).hover({ position: { x: 16, y: 200 } });
  const start = await place(page);
  await recorded(page);
  let was = start;
  for (let step = 1; step <= count; step += 1) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(wait);
    const now = await place(page);
    const frames = await recorded(page);
    const label = `wheel ${step}`;
    const away = now.gap - start.gap;
    // While a reply streams, the end moves away as well: at least the wheels' distance.
    if (streaming)
      expect.soft(now.gap, `${label}: distance to the end`).toBeGreaterThan(300 * step - 1);
    else
      expect
        .soft(Math.abs(away - 300 * step), `${label}: distance to the end`)
        .toBeLessThanOrEqual(1);
    // Before the first wheel a streaming reply is still followed, so its rows were moving up
    // with the end until the wheel landed.
    if (!(streaming && step === 1))
      expect
        .soft(Math.abs(moved(was, now) + 300), `${label}: the rows read`)
        .toBeLessThanOrEqual(1);
    expect.soft(frames.minGap, `${label}: the nearest the end came`).toBeGreaterThan(was.gap - 2);
    await expect.soft(latest(page), `${label}: Jump to latest`).toBeVisible();
    was = now;
  }
  return was;
}

// Runs whose replies are taller than the view: each run row draws one line until its record
// has loaded, then grows (docs/specs/chat-widgets-contract.md SCROLL-02: reading earlier
// messages is never pulled back to the end).
test.describe('tall runs above the end', () => {
  test.use({ live: true, codexLogin: true, streamTokensPerSecond: 120 });

  test('wheeling up over runs taller than the view leaves the end, still and while a reply streams', async ({
    page,
    corral,
  }) => {
    test.setTimeout(300_000);
    await open(page, corral, 60);
    const runs = () => [...corral.server.coordinator.listRuns()];
    const finished = (count: number) =>
      expect
        .poll(
          () =>
            runs().length === count &&
            runs().every(
              (run) =>
                corral.server.coordinator.getSnapshot(run.runId).projection.status === 'succeeded',
            ),
          { timeout: 180_000, intervals: [100] },
        )
        .toBe(true);
    for (let index = 1; index <= 8; index += 1) {
      corral.fake?.setResponses([fauxAssistantMessage(TALL_REPLY(40))]);
      await requestBox(page).fill(`Tall reply ${index}`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await finished(index);
      await expect(runGoing(page)).toHaveCount(0);
    }
    const tallest = await timeline(page)
      .locator('[data-chat-item]')
      .last()
      .evaluate((row) => row.getBoundingClientRect().height);
    expect(tallest).toBeGreaterThan((await place(page)).visible);

    // Still: reloaded at the end, every run's record loads again as its row mounts.
    await page.reload();
    await expect(timeline(page)).toContainText('Tall reply 8');
    await waitForStill(page);
    expect((await place(page)).gap).toBeLessThanOrEqual(1);
    await record(page);
    const read = await wheelUpFromEnd(page, 10, 300, false);
    expect(read.gap).toBeGreaterThanOrEqual(2_998);
    // Staying there: nothing writes the offset and no row mounts or leaves.
    await recorded(page);
    await page.waitForTimeout(3_000);
    const still = await recorded(page);
    expect(still.writes).toBe(0);
    expect(still.sets).toBe(1);
    expect(Math.abs((await place(page)).top - read.top)).toBeLessThanOrEqual(1);
    await expect(latest(page)).toBeVisible();

    // While a reply streams below, after a reload.
    await latest(page).click();
    await page.reload();
    await expect(timeline(page)).toContainText('Tall reply 8');
    await waitForStill(page);
    corral.fake?.setResponses([fauxAssistantMessage(TALL_REPLY(400))]);
    await requestBox(page).fill('Explain again while I read above');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('live-text')).toBeVisible({ timeout: 60_000 });
    await record(page);
    const streaming = await wheelUpFromEnd(page, 6, 120, true);
    // Still streaming after the wheels: a reply ending would change the rows below the reader.
    const running = () =>
      runs().filter(
        (run) => corral.server.coordinator.getSnapshot(run.runId).projection.status === 'running',
      );
    expect(running()).toHaveLength(1);
    await recorded(page);
    await page.waitForTimeout(3_000);
    const reading = await recorded(page);
    // The reply was still streaming the whole time, and the reader was left where they were.
    expect(running()).toHaveLength(1);
    expect(reading.writes).toBe(0);
    expect(reading.sets).toBe(1);
    expect(Math.abs((await place(page)).top - streaming.top)).toBeLessThanOrEqual(1);
    await expect(latest(page)).toBeVisible();
    await finished(9);
    expect(corral.errors).toEqual([]);
  });
});
