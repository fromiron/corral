import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage } from '@corral/server/testing';
import type { Locator, Page } from '@playwright/test';
import { expect, type Harness, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';
import {
  conversation,
  drag,
  FIRST,
  keepQuotes,
  NOT_FOUND,
  quoted,
  requests,
  runStates,
  SECOND,
  selected,
  sendEntry,
  sendQuote,
  sentChip,
  wordPoints,
} from './replies.ts';
import {
  checkChrome,
  checkLabels,
  measure as measureScene,
  msg,
  nothingWaiting,
  shot,
} from './scene.ts';

// Scene ⑤, quoting a reply (docs/specs/features/reply-citation.md): a passage chosen by keys
// alone in one reply, quoted with Alt+Q, sent, and led back to from the sent chip once its row
// has left the window. The toolbar coming and going and each chip joining the request box move
// no conversation item more than 1px in its container and the input box's bottom edge not at
// all (docs/plans/unified-flow.md §9).
// Chromium without caret browsing (F7) has no caret in read-only text, so a script chooses the
// passage's first character where that caret would stand; Shift+Arrow then chooses the rest, as
// a keyboard user does.

const OUT = join(import.meta.dirname, '..', '..', 'test-results', 'flow');
const SHOTS = join(OUT, 'citation');
const RESULTS = join(OUT, 'citation.json');

const probeOptions = {
  itemSelector: '[data-chat-item]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

type Recorded = Omit<ShiftResult, 'name' | 'items'>;
function record(name: string, shift: Recorded) {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, Recorded> = existsSync(RESULTS)
    ? JSON.parse(readFileSync(RESULTS, 'utf8'))
    : {};
  results[name] = shift;
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
}

/** The largest shift of the conversation items alone. */
function itemShift(result: ShiftResult) {
  const values = result.items
    .filter((item) => item.kind === 'item')
    .flatMap((item) => [item.maxContainerShiftYPx, item.maxContainerShiftXPx]);
  return values.length ? Math.max(...values) : null;
}

async function measure(page: Page, name: string, happen: () => Promise<void>) {
  const probe = createProbe(page, probeOptions);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-before.png`) });
  await probe.start(name);
  await happen();
  await waitForStill(page);
  const result = await probe.stop();
  await page.screenshot({ path: join(SHOTS, `${name}-after.png`) });
  const { name: _name, items: _items, ...shift } = result;
  record(name, { ...shift, maxContainerShiftPx: itemShift(result) });
  expect(result.samples.frames, `${name}: frames`).toBeGreaterThan(0);
  expect(result.samples.tracked.item, `${name}: conversation items`).toBeGreaterThan(0);
  expect.soft(itemShift(result), `${name}: container shift`).toBeLessThanOrEqual(1);
  expect.soft(result.maxInputBottomChangePx, `${name}: input bottom`).toBe(0);
  return result;
}

/** The first character of `word` in the first reply body chosen, where caret browsing would be. */
async function chooseFrom(page: Page, word: string) {
  await page.evaluate((word) => {
    const body = document.querySelector<HTMLElement>('[data-reply-body]');
    if (!body) throw new Error('no reply body');
    // Caret browsing takes focus with its caret, out of the request box.
    body.focus({ preventScroll: true });
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(word) ?? -1;
      if (at < 0) continue;
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.setBaseAndExtent(node, at, node, at + 1);
      return;
    }
    throw new Error(`no ${word} in the reply`);
  }, word);
}
/** Chooses the rest of `length` characters on from there by keys alone. */
async function extend(page: Page, length: number) {
  for (let step = 1; step < length; step += 1) await page.keyboard.press('Shift+ArrowRight');
}

test.use({ live: true, codexLogin: true });

test('a passage chosen by keys is quoted, sent, and led back to in its reply', async ({
  page,
  corral,
}) => {
  test.setTimeout(180_000);
  const runs = () => [...corral.server.coordinator.listRuns()].reverse();
  const status = (index: number) => {
    const run = runs()[index];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection.status : null;
  };
  corral.fake?.setResponses([
    fauxAssistantMessage(`${FIRST}\n\n${SECOND}`),
    fauxAssistantMessage('Noted.'),
  ]);

  await corral.open('/projects/default');
  await newConversation(page);
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  await requestBox(page).fill('Tell me about the fox');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => status(0), { timeout: 30_000 }).toBe('succeeded');
  await expect(page.locator('[data-reply-body]')).toContainText(FIRST);
  // Later requests that never ran, enough to push the reply out of the window once the
  // conversation follows its end again.
  await page.evaluate(async (id) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    for (let index = 0; index < 48; index += 1) {
      const response = await fetch(`/api/v1/sessions/${id}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({
          intent: 'next',
          text: `Later request ${index + 1}. ${'Long enough to wrap over several lines. '.repeat(4)}`,
          state: 'refused',
        }),
      });
      if (!response.ok) throw new Error(`filler entry: ${response.status}`);
    }
  }, sessionId);
  await page.reload();
  await expect(page.locator('[data-chat-item]').first()).toBeVisible();
  // Up to the reply, which starts the conversation.
  await page.getByTestId('chat-timeline').hover({ position: { x: 16, y: 200 } });
  const reply = page.locator('[data-reply-body]').filter({ hasText: FIRST });
  for (let step = 0; step < 80 && !(await reply.count()); step += 1)
    await page.mouse.wheel(0, -1200);
  await reply.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-reply-body]').first()).toContainText(FIRST);
  await waitForStill(page);

  const toolbar = page.getByTestId('reply-selection');
  const composer = page.getByTestId('chat-composer');
  const chips = composer.getByRole('list', { name: 'Quotes', exact: true }).getByRole('listitem');

  // The toolbar comes with a passage chosen by keys, and goes with Escape.
  await chooseFrom(page, 'quick');
  await measure(page, 'toolbar-show', async () => {
    await extend(page, 'quick brown'.length);
    await expect(toolbar).toBeVisible();
  });
  expect(await selected(page)).toBe('quick brown');
  await expect(toolbar.getByRole('button', { name: /^Quote/ })).toContainText('Alt+Q');
  // Over the passage's first line, at its start.
  const line = (await selectionLines(page)).first;
  const bar = await boxOf(toolbar);
  expect(bar.bottom).toBeLessThanOrEqual((line?.top ?? 0) + 0.5);
  expect(Math.abs(bar.left - (line?.left ?? 0))).toBeLessThanOrEqual(1);
  await measure(page, 'toolbar-hide', async () => {
    await page.keyboard.press('Escape');
    await expect(toolbar).toBeHidden();
  });

  // Alt+Q makes the chip and puts the caret in the request box.
  await chooseFrom(page, 'quick');
  await extend(page, 'quick brown'.length);
  await expect(toolbar).toBeVisible();
  const before = await requestBox(page).boundingBox();
  await measure(page, 'chip-1', async () => {
    await page.keyboard.press('Alt+KeyQ');
    await expect(chips).toHaveCount(1);
  });
  await expect(requestBox(page)).toBeFocused();
  await expect(toolbar).toBeHidden();
  await expect(chips.first()).toContainText('quick brown');

  // A second chip: the input box's bottom edge stays put as chips join.
  await chooseFrom(page, 'another');
  await extend(page, 'another passage'.length);
  await expect(toolbar).toBeVisible();
  await measure(page, 'chip-2', async () => {
    await page.keyboard.press('Alt+KeyQ');
    await expect(chips).toHaveCount(2);
  });
  const after = await requestBox(page).boundingBox();
  expect(
    Math.abs((after?.y ?? 0) + (after?.height ?? 0) - (before?.y ?? 0) - (before?.height ?? 0)),
  ).toBe(0);

  // Sent: the request shows its quotes as chips leading back.
  await page.keyboard.type('What do these mean?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => status(1), { timeout: 30_000 }).toBe('succeeded');
  const sent = page
    .locator('[data-chat-item]')
    .filter({ hasText: 'What do these mean?' })
    .getByRole('button', { name: /^Go to the quoted passage/ });
  await expect(sent).toHaveCount(2);
  await waitForStill(page);
  // The reply's row has left the window.
  await expect(page.locator('[data-reply-body]').filter({ hasText: FIRST })).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, 'sent.png') });

  // Led back: the reply is drawn again, the passage is chosen and marked, and focus is there.
  await sent.first().click();
  const body = page.locator('[data-reply-body]').filter({ hasText: FIRST });
  await expect(body).toBeFocused();
  expect(await selected(page)).toBe('quick brown');
  expect(await page.evaluate(() => CSS.highlights?.has('corral-quote') ?? false)).toBe(true);
  await expect(toolbar).toBeHidden();
  await expect(page.getByText("Couldn't find the passage in the reply")).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, 'led-back.png') });
  // In view, and the chip leads there again.
  const area = await visibleArea(page);
  const passage = (await selectionLines(page)).first;
  if (!passage) throw new Error('no passage');
  expect(within(passage, area)).toBe(true);
  expect(corral.errors).toEqual([]);
});

// Placement: where the toolbar, the quote's detail and a led-back passage stand on screen.

type Box = { top: number; bottom: number; left: number; right: number };
/** The first and last lines the selection is drawn on. */
const selectionLines = (page: Page) =>
  page.evaluate(() => {
    const range = document.getSelection()?.getRangeAt(0);
    const lines = [...(range?.getClientRects() ?? [])].filter((r) => r.width > 0 && r.height > 0);
    const box = (r: DOMRect | undefined) =>
      r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
    return { first: box(lines[0]), last: box(lines[lines.length - 1]) };
  });
/** The part of the conversation a person sees: below its top, above the composer, in its column. */
const visibleArea = (page: Page) =>
  page.evaluate(() => {
    const view = document.querySelector('[data-testid="chat-timeline"]')?.getBoundingClientRect();
    const composer = document
      .querySelector('[data-testid="chat-composer"]')
      ?.getBoundingClientRect();
    const column = document.querySelector('[data-chat-window]')?.getBoundingClientRect();
    if (!view || !composer || !column) throw new Error('no conversation');
    return { top: view.top, bottom: composer.top, left: column.left, right: column.right };
  });
const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('not drawn');
  return { top: box.y, bottom: box.y + box.height, left: box.x, right: box.x + box.width };
};
const within = (inner: Box, outer: Box) =>
  inner.top >= outer.top - 0.5 &&
  inner.bottom <= outer.bottom + 0.5 &&
  inner.left >= outer.left - 0.5 &&
  inner.right <= outer.right + 0.5;

test('the toolbar stands over the passage’s first line, at its start, and under it only at the top edge', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  corral.fake?.setResponses([fauxAssistantMessage(`${FIRST}\n\n${SECOND}`)]);
  await conversation(page, corral, 24);
  await page.reload();
  await page.getByTestId('chat-timeline').hover({ position: { x: 16, y: 200 } });
  const reply = page.locator('[data-reply-body]').filter({ hasText: FIRST });
  for (let step = 0; step < 80 && !(await reply.count()); step += 1)
    await page.mouse.wheel(0, -1200);
  // The passage's line in the middle of the view: the toolbar goes over it.
  await reply.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await waitForStill(page);
  const toolbar = page.getByTestId('reply-selection');
  await chooseFrom(page, 'brown');
  await extend(page, 'brown fox jumps'.length);
  await expect(toolbar).toBeVisible();
  await waitForStill(page);
  let lines = await selectionLines(page);
  let bar = await boxOf(toolbar);
  const area = await visibleArea(page);
  expect(bar.bottom).toBeLessThanOrEqual((lines.first?.top ?? 0) + 0.5);
  expect(Math.abs(bar.left - (lines.first?.left ?? 0))).toBeLessThanOrEqual(1);
  expect(within(bar, area)).toBe(true);
  await page.screenshot({ path: join(SHOTS, 'toolbar-over.png') });
  await page.keyboard.press('Escape');
  // The passage's line at the top edge of the view: no room over it, so the toolbar goes under.
  const top = await page.evaluate(() => {
    const view = document.querySelector('[data-testid="chat-timeline"]')?.getBoundingClientRect();
    const range = document.getSelection()?.getRangeAt(0);
    return (range?.getClientRects()[0]?.top ?? 0) - (view?.top ?? 0);
  });
  await page.getByTestId('chat-timeline').evaluate((box, by) => {
    box.scrollTop += by;
  }, top - 4);
  await waitForStill(page);
  await chooseFrom(page, 'brown');
  await extend(page, 'brown fox jumps'.length);
  await expect(toolbar).toBeVisible();
  await waitForStill(page);
  lines = await selectionLines(page);
  expect((lines.first?.top ?? 0) - area.top).toBeLessThan(30);
  bar = await boxOf(toolbar);
  expect(bar.top).toBeGreaterThanOrEqual((lines.last?.bottom ?? 0) - 0.5);
  expect(within(bar, area)).toBe(true);
  await page.screenshot({ path: join(SHOTS, 'toolbar-under.png') });
  expect(corral.errors).toEqual([]);
});

test('a passage gone from a reply in view: the view stays, and the chip says so with its words', async ({
  page,
  corral,
}) => {
  corral.fake?.setResponses([fauxAssistantMessage(`${FIRST}\n\n${SECOND}`)]);
  const reply = await conversation(page, corral, 0);
  await sendQuote(page, reply, 'a passage that is gone', 4);
  await page.reload();
  const chip = sentChip(page);
  await expect(chip).toBeVisible();
  await waitForStill(page);
  const scrolled = () =>
    page.getByTestId('chat-timeline').evaluate((box) => Math.round(box.scrollTop));
  const before = await scrolled();
  await chip.click();
  const detail = page.getByTestId('quote-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(NOT_FOUND);
  await expect(detail.locator('blockquote')).toHaveText('a passage that is gone');
  await expect(chip).toHaveAccessibleDescription(NOT_FOUND);
  await expect(sentChip(page)).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: NOT_FOUND })).toHaveCount(1);
  expect(await scrolled()).toBe(before);
  expect(within(await boxOf(detail), { ...(await visibleArea(page)), left: 0, right: 1e4 })).toBe(
    true,
  );
  await page.screenshot({ path: join(SHOTS, 'not-found-in-view.png') });
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(chip).toHaveAccessibleDescription(NOT_FOUND);
  expect(corral.errors).toEqual([]);
});

test('a passage gone from a reply out of the window: back where the chip was, saying so', async ({
  page,
  corral,
}) => {
  corral.fake?.setResponses([fauxAssistantMessage(`${FIRST}\n\n${SECOND}`)]);
  const reply = await conversation(page, corral, 48);
  await sendQuote(page, reply, 'a passage that is gone', 4);
  await page.reload();
  const chip = sentChip(page);
  await expect(chip).toBeVisible();
  await waitForStill(page);
  await expect(page.locator('[data-reply-body]')).toHaveCount(0);
  const before = await boxOf(chip);
  await chip.click();
  const detail = page.getByTestId('quote-detail');
  await expect(detail).toBeVisible({ timeout: 10_000 });
  await waitForStill(page);
  const after = await boxOf(chip);
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
  await expect(chip).toHaveAccessibleDescription(NOT_FOUND);
  expect(within(await boxOf(detail), { ...(await visibleArea(page)), left: 0, right: 1e4 })).toBe(
    true,
  );
  await page.screenshot({ path: join(SHOTS, 'not-found-away.png') });
  expect(corral.errors).toEqual([]);
});

test('a passage late in a reply taller than two views is led back to in view, and held there', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  const paragraphs = Array.from(
    { length: 48 },
    (_, index) =>
      `Paragraph ${index + 1} of the long reply, long enough to wrap over a second line of the conversation column.`,
  );
  const PASSAGE = 'Paragraph 46 of the long reply';
  corral.fake?.setResponses([fauxAssistantMessage(paragraphs.join('\n\n'))]);
  const reply = await conversation(page, corral, 0);
  const height = await page
    .locator('[data-reply-body]')
    .first()
    .evaluate((node) => node.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(2 * (page.viewportSize()?.height ?? 800));
  await requests(page, reply.sessionId, 24);
  await sendQuote(page, reply, PASSAGE, reply.drawn.indexOf(PASSAGE));
  await page.reload();
  const chip = sentChip(page);
  await expect(chip).toBeVisible();
  await waitForStill(page);
  await chip.click();
  const body = page.locator('[data-reply-body]').first();
  await expect(body).toBeFocused();
  expect(await selected(page)).toBe(PASSAGE);
  await waitForStill(page);
  const area = await visibleArea(page);
  const shown = await selectionLines(page);
  if (!shown.first || !shown.last) throw new Error('no passage');
  expect(within({ ...shown.first, bottom: shown.last.bottom }, area)).toBe(true);
  // Held: the reader's place is the passage, and nothing pulls it away again.
  await page.waitForTimeout(800);
  const held = await selectionLines(page);
  expect(Math.abs((held.first?.top ?? 0) - shown.first.top)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: join(SHOTS, 'long-reply.png') });
  expect(corral.errors).toEqual([]);
});

// Chosen by hand: passages the mouse chooses, as a person does, and what the toolbar, the quote
// and its return make of them (reply-citation.md: the toolbar follows the selection now; a quote
// holds what copying the passage gives).

const ROUND3 = join(OUT, 'citation-round3');
const ONLY = 'Only one paragraph stands in this reply.';

/** Two replies: the first of two paragraphs, the last of one paragraph with no row under it. */
async function twoReplies(page: Page, corral: Harness) {
  corral.fake?.setResponses([
    fauxAssistantMessage(`${FIRST}\n\n${SECOND}`),
    fauxAssistantMessage(ONLY),
    fauxAssistantMessage('Noted.'),
  ]);
  const reply = await conversation(page, corral, 0);
  await requestBox(page).fill('One more');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => runStates(corral), { timeout: 30_000 }).toBe('succeeded,succeeded');
  await expect(page.locator('[data-reply-body]')).toHaveCount(2);
  await waitForStill(page);
  return reply;
}

/**
 * What stands half a second after the pointer let go: the toolbar, the words chosen, and whether
 * the toolbar is over the passage's first line at its start (a passage chosen whole by clicks
 * ends past its last line, so only drags are placed).
 */
async function after(page: Page) {
  await page.waitForTimeout(500);
  const toolbar = page.getByTestId('reply-selection');
  const text = (await selected(page)).trim();
  if (!(await toolbar.isVisible())) return { shown: false, text };
  const line = (await selectionLines(page)).first;
  const bar = await boxOf(toolbar);
  const over = !!line && bar.bottom <= line.top + 0.5 && Math.abs(bar.left - line.left) <= 1;
  return { shown: true, text, over };
}
const clear = async (page: Page) => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await page.waitForTimeout(200);
};
const paragraph = (page: Page, body: number, index: number) =>
  page.locator('[data-reply-body]').nth(body).locator('p').nth(index);
async function clicks(page: Page, body: number, index: number, count: number) {
  const box = await paragraph(page, body, index).boundingBox();
  if (!box) throw new Error('no paragraph');
  await page.mouse.click(box.x + 80, box.y + 8, { clickCount: count });
}
/** A drag from `word` in paragraph `index` of reply `body`, let go `under` px below the paragraph. */
async function dragUnder(page: Page, body: number, index: number, word: string, under: number) {
  const box = await paragraph(page, body, index).boundingBox();
  if (!box) throw new Error('no paragraph');
  const at = await wordPoints(page, body, word, word);
  await page.mouse.move(at.from.x, at.from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + box.height + under, { steps: 8 });
  await page.mouse.up();
}

test('the toolbar follows each passage the mouse chooses, by a drag, two clicks or three', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  await twoReplies(page, corral);
  await keepQuotes(page);
  // One drag after another, while the toolbar of the one before still stands.
  for (const [from, to, text] of [
    ['quick', 'brown', 'quick brown'],
    ['lazy', 'dog', 'lazy dog'],
    ['fox', 'jumps', 'fox jumps'],
  ] as const) {
    await drag(page, 0, from, to);
    expect(await after(page), text).toEqual({ shown: true, text, over: true });
  }
  // Two clicks choose a word, three its paragraph, while a toolbar stands.
  const brown = await wordPoints(page, 0, 'brown', 'brown');
  await page.mouse.click(brown.from.x + 4, brown.from.y, { clickCount: 2 });
  expect(await after(page), 'two clicks').toEqual({ shown: true, text: 'brown', over: true });
  await clicks(page, 0, 0, 3);
  expect((await after(page)).shown, 'three clicks, first paragraph').toBe(true);
  expect(await selected(page)).toContain(FIRST);
  // The last paragraph of a reply, where the browser ends the choice past the reply's body.
  await clicks(page, 0, 1, 3);
  const last = await after(page);
  expect(last.shown, 'three clicks, last paragraph').toBe(true);
  expect(last.text).toBe(SECOND);
  await clicks(page, 1, 0, 3);
  const only = await after(page);
  expect(only.shown, 'three clicks, the only paragraph of the last reply').toBe(true);
  mkdirSync(ROUND3, { recursive: true });
  await page.screenshot({ path: join(ROUND3, 'triple-click-last-paragraph.png') });
  await page.keyboard.press('Alt+KeyQ');
  await expect(requestBox(page)).toBeFocused();
  // What a copy of a whole paragraph gives, without the line break it ends with.
  expect((await quoted(page)).at(-1)?.text).toBe(ONLY);
  // A drag let go a little under a reply's last line, with a row under it and with none.
  for (const [body, index, word, rest] of [
    [0, 1, 'paragraph', 'paragraph holds another passage worth quoting.'],
    [1, 0, 'paragraph', 'paragraph stands in this reply.'],
  ] as const) {
    for (const under of [8, 24]) {
      await clear(page);
      await dragUnder(page, body, index, word, under);
      const chosen = await after(page);
      expect(chosen, `reply ${body}, ${under}px under`).toMatchObject({ shown: true, text: rest });
    }
    const count = (await quoted(page)).length;
    await page.keyboard.press('Alt+KeyQ');
    await expect.poll(async () => (await quoted(page)).length).toBe(count + 1);
    expect((await quoted(page)).at(-1)?.text).toBe(rest);
  }
  // Sent, each quote leads back to its words.
  await clear(page);
  await requestBox(page).fill('Where are these?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(() => runStates(corral), { timeout: 30_000 })
    .toBe('succeeded,succeeded,succeeded');
  const chips = sentChip(page, 'Where are these?');
  await expect(chips).toHaveCount(3);
  await waitForStill(page);
  for (const [index, text] of [
    ONLY,
    'paragraph holds another passage worth quoting.',
    'paragraph stands in this reply.',
  ].entries()) {
    await chips.nth(index).click();
    await expect.poll(() => selected(page), text).toBe(text);
    await expect(page.getByTestId('quote-detail')).toHaveCount(0);
  }
  // Over two replies: no toolbar.
  await clear(page);
  const from = await wordPoints(page, 0, 'lazy', 'lazy');
  const to = await wordPoints(page, 1, 'stands', 'stands');
  await page.mouse.move(from.from.x, from.from.y);
  await page.mouse.down();
  await page.mouse.move(to.to.x, to.to.y, { steps: 8 });
  await page.mouse.up();
  expect((await after(page)).shown, 'over two replies').toBe(false);
  expect(corral.errors).toEqual([]);
});

const CODE = [
  'Before the code.',
  '',
  '```ts',
  'const answer = 42;',
  'console.log(answer);',
  '```',
  '',
  'After the code.',
].join('\n');

test('a passage chosen in a code block stays chosen, its toolbar over its line, as the conversation refreshes', async ({
  page,
  corral,
}) => {
  corral.fake?.setResponses([fauxAssistantMessage(CODE)]);
  await conversation(page, corral, 0);
  await waitForStill(page);
  await drag(page, 0, 'const', '42');
  const shown = await after(page);
  expect(shown).toEqual({ shown: true, text: 'const answer = 42', over: true });
  // Past a refresh of the run list, which draws the reply again.
  await page.waitForTimeout(2000);
  expect(await after(page)).toEqual(shown);
  mkdirSync(ROUND3, { recursive: true });
  await page.screenshot({ path: join(ROUND3, 'code-block-toolbar.png') });
  expect(corral.errors).toEqual([]);
});

const RICH = [
  'Plain words with **bold words** and `inline code` and a [link text](https://example.com) here.',
  '',
  '- First item of the list',
  '- Second item of the list',
  '',
  '```ts',
  'const answer = 42;',
  'console.log(answer);',
  '```',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| alpha | one |',
  '| beta | two |',
  '',
  'The end of the reply.',
].join('\n');

test('a quote holds what copying the passage gives, and leads back to it', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  corral.fake?.setResponses([fauxAssistantMessage(RICH), fauxAssistantMessage('Noted.')]);
  const reply = await conversation(page, corral, 0);
  await waitForStill(page);
  await keepQuotes(page);
  const toolbar = page.getByTestId('reply-selection');
  const cases = [
    ['a table', 'alpha', 'two', 'alpha\tone\nbeta\ttwo'],
    [
      'a list and a code block',
      'First',
      'answer);',
      'First item of the list\nSecond item of the list\nconst answer = 42;\nconsole.log(answer);',
    ],
    [
      'words in bold, code and a link',
      'bold',
      'here.',
      'bold words and inline code and a link text here.',
    ],
  ] as const;
  for (const [index, [name, from, to, text]] of cases.entries()) {
    await drag(page, 0, from, to);
    await expect(toolbar, name).toBeVisible();
    await page.keyboard.press('Control+KeyC');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Alt+KeyQ');
    await expect.poll(async () => (await quoted(page)).length, name).toBe(index + 1);
    const quote = (await quoted(page)).at(-1);
    expect(quote?.text, `${name}: as copied`).toBe(copied);
    expect(quote?.text, name).toBe(text);
  }
  // Sent, then led back to each: the passage is chosen again, as it was copied.
  await page.keyboard.type('What do these say?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => runStates(corral), { timeout: 30_000 }).toBe('succeeded,succeeded');
  const chips = sentChip(page, 'What do these say?');
  await expect(chips).toHaveCount(cases.length);
  await waitForStill(page);
  for (const [index, [name, , , text]] of cases.entries()) {
    await chips.nth(index).click();
    await expect(page.locator('[data-reply-body]').first(), name).toBeFocused();
    expect(await selected(page), `${name}: led back`).toBe(text);
    await expect(page.getByTestId('quote-detail')).toHaveCount(0);
  }
  // A table's quote whose reply is gone: its detail shows the words in their cells.
  const table = (await quoted(page))[0];
  await sendEntry(page, reply.sessionId, 'About the table', [
    { ...table, provenance: { ...(table?.provenance ?? {}), runId: 'run_gone' } },
  ]);
  const gone = sentChip(page, 'About the table');
  await expect(gone).toBeVisible();
  await waitForStill(page);
  await gone.click();
  const detail = page.getByTestId('quote-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('blockquote')).toHaveText('alpha\tone\nbeta\ttwo', {
    useInnerText: true,
  });
  mkdirSync(ROUND3, { recursive: true });
  await page.screenshot({ path: join(ROUND3, 'table-quote-detail.png') });
  expect(corral.errors).toEqual([]);
});

test('the toolbar keeps to its passage as the window changes; it and a quote’s detail are named, and the detail closes as focus leaves', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  corral.fake?.setResponses([fauxAssistantMessage(`${FIRST}\n\n${SECOND}`)]);
  const reply = await conversation(page, corral, 0);
  await sendQuote(page, reply, 'a passage that is gone', 4);
  await page.reload();
  await expect(sentChip(page)).toBeVisible();
  await waitForStill(page);
  await drag(page, 0, 'brown', 'jumps');
  const toolbar = page.getByRole('toolbar', { name: 'Selected passage', exact: true });
  await expect(toolbar).toBeVisible();
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.setViewportSize({ width: 1000, height: 600 });
  await waitForStill(page);
  const shown = await after(page);
  expect(shown, 'a narrower, lower window').toEqual({
    shown: true,
    text: 'brown fox jumps',
    over: true,
  });
  await page.setViewportSize(size);
  await waitForStill(page);
  expect(await after(page), 'the window as it was').toEqual(shown);
  await clear(page);
  // The chip says whether its detail is open; the detail is named and goes as focus leaves.
  const chip = sentChip(page);
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await chip.click();
  const detail = page.getByRole('dialog', { name: NOT_FOUND, exact: true });
  await expect(detail).toBeVisible();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await expect(chip).toBeFocused();
  // Into the detail and on out of it: the detail goes as focus leaves, and focus is where it went.
  for (let step = 0; step < 3 && (await detail.isVisible()); step += 1)
    await page.keyboard.press('Tab');
  await expect(detail).toBeHidden();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  await page.keyboard.press('Shift+Tab');
  await expect(chip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(detail).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(chip).toBeFocused();
  expect(corral.errors).toEqual([]);
});

// A passage looked for far away and not found (reply-citation.md: back to the chip, unless the
// person moved meanwhile; a conversation that followed its end goes on following it).

test('a passage not found far away: a conversation that followed its end goes on following it', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  corral.fake?.setResponses([fauxAssistantMessage(`${FIRST}\n\n${SECOND}`)]);
  const reply = await conversation(page, corral, 48);
  await sendQuote(page, reply, 'quick brown', reply.drawn.indexOf('quick brown'), {
    modelCallId: 'call_never_drawn',
  });
  await page.reload();
  const chip = sentChip(page);
  await expect(chip).toBeVisible();
  await waitForStill(page);
  const gap = () =>
    page
      .getByTestId('chat-timeline')
      .evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight);
  expect(await gap()).toBeLessThanOrEqual(1);
  await chip.click();
  await expect(page.getByTestId('quote-detail')).toBeVisible({ timeout: 10_000 });
  await waitForStill(page);
  expect(await gap(), 'back at the end').toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await requests(page, reply.sessionId, 1, 'Arrived request');
  await expect(
    page.locator('[data-chat-item]').filter({ hasText: 'Arrived request 1.' }),
  ).toBeVisible();
  await waitForStill(page);
  expect(await gap(), 'a request arrived: still at the end').toBeLessThanOrEqual(1);
  expect(corral.errors).toEqual([]);
});

test('a passage not found far away: a person who moved while it was looked for stays where they went', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  corral.fake?.setResponses([fauxAssistantMessage(`${FIRST}\n\n${SECOND}`)]);
  const reply = await conversation(page, corral, 48);
  await sendQuote(page, reply, 'quick brown', reply.drawn.indexOf('quick brown'), {
    modelCallId: 'call_never_drawn',
  });
  await page.reload();
  const chip = sentChip(page);
  await expect(chip).toBeVisible();
  await waitForStill(page);
  await chip.click();
  await page.waitForTimeout(900);
  await page.getByTestId('chat-timeline').hover({ position: { x: 16, y: 200 } });
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 700);
  await waitForStill(page);
  const where = () =>
    page.getByTestId('chat-timeline').evaluate((box) => {
      const top = box.getBoundingClientRect().top;
      const row = [...box.querySelectorAll<HTMLElement>('[data-chat-item]')].find(
        (item) => item.getBoundingClientRect().bottom > top,
      );
      return { id: row?.dataset.chatItem, offset: (row?.getBoundingClientRect().top ?? 0) - top };
    });
  const went = await where();
  await expect(page.getByTestId('quote-detail')).toBeVisible({ timeout: 10_000 });
  await waitForStill(page);
  const now = await where();
  expect(now.id, 'the row read').toBe(went.id);
  expect(Math.abs(now.offset - went.offset), 'where it is').toBeLessThanOrEqual(1);
  expect(corral.errors).toEqual([]);
});

test('the quote key bound in settings goes out in an export and comes back, and a browser’s Alt key is refused', async ({
  page,
  corral,
}) => {
  await corral.open('/settings?section=shortcuts');
  const row = page.getByRole('button', { name: /Quote the selected reply text/ });
  await expect(row).toBeVisible();
  const stored = () => page.evaluate(() => localStorage.getItem('corral:shortcuts:v1:web'));
  // A key the browser keeps with Alt: refused, nothing saved.
  await row.click();
  await page.keyboard.press('Alt+KeyD');
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await stored()).toBeNull();
  await page.keyboard.press('Escape');
  await row.click();
  await page.keyboard.press('Alt+KeyW');
  await expect(row).toContainText('Alt+W');
  const shortcuts = JSON.parse((await stored()) ?? '{}');
  expect(shortcuts['reply.quote']).toMatchObject({ key: 'w', alt: true });
  const back = await page.evaluate(async (shortcuts) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`/api/v1/vault/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return response.json();
    };
    const password = 'a long enough password';
    const application = {
      version: 1,
      theme: 'system',
      locale: 'en',
      sendKey: 'enter',
      notify: false,
      shortcuts,
    };
    const { envelope } = await post('export', {
      password,
      domains: ['application'],
      application,
      bindings: {},
      includeSecrets: [],
    });
    const preview = await post('preview', { envelope, password, application, bindings: {} });
    const applied = await post('apply', {
      previewId: preview.previewId,
      password,
      domains: ['application'],
    });
    const pending = await post('pending', { password });
    const target = pending.application?.target;
    const acknowledged = await post('acknowledge', {
      id: applied.id,
      password,
      application: target,
    });
    return { shortcuts: target?.shortcuts, status: acknowledged.status };
  }, shortcuts);
  expect(back).toEqual({ shortcuts, status: 'committed' });
  expect(corral.errors).toEqual([]);
});

// V2, scene ⑤ (docs/plans/unified-flow.md §9): the final scene with every pass mark of §9
// "측정" (scene.ts), by the keyboard alone. The conversation is taller than its view; Home on the
// timeline reaches the reply, a passage is chosen by keys, Alt+Q quotes it twice (the input box's
// bottom edge holds as the chips join), Enter sends, and the sent chip, reached by the keyboard,
// leads back to the passage, chosen and marked. Recorded in test-results/flow/report.json.
test.describe('V2 quoting a reply', () => {
  const SCENE = 'citation';

  test('⑤ chosen by keys, quoted with Alt+Q twice, sent, and led back to from its chip', async ({
    page,
    corral,
  }) => {
    test.setTimeout(180_000);
    const runs = () => [...corral.server.coordinator.listRuns()].reverse();
    const status = (index: number) => {
      const run = runs()[index];
      return run ? corral.server.coordinator.getSnapshot(run.runId).projection.status : null;
    };
    corral.fake?.setResponses([
      fauxAssistantMessage(`${FIRST}\n\n${SECOND}`),
      fauxAssistantMessage('Noted.'),
    ]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await corral.open('/projects/default');
    await newConversation(page);
    const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
    const box = requestBox(page);
    await box.fill('Tell me about the fox');
    await box.press('Enter');
    await expect.poll(() => status(0), { timeout: 30_000 }).toBe('succeeded');
    await expect(page.locator('[data-reply-body]')).toContainText(FIRST);
    // Later requests that never ran: the conversation is taller than its view.
    await requests(page, sessionId, 12);
    await page.reload();
    await expect(page.locator('[data-chat-item]').last()).toContainText('Later request 12.');
    await waitForStill(page);

    // Home on the timeline reaches the reply.
    await page.getByTestId('chat-timeline').focus();
    await page.keyboard.press('Home');
    const reply = page.locator('[data-reply-body]').filter({ hasText: FIRST });
    await expect(reply).toBeInViewport();
    await waitForStill(page);
    await checkLabels(page, SCENE, 'reading the reply');

    const toolbar = page.getByTestId('reply-selection');
    const chips = page
      .getByTestId('chat-composer')
      .getByRole('list', { name: msg('Composer.quotes'), exact: true })
      .getByRole('listitem');

    // A passage chosen by keys brings the toolbar; nothing on screen moves.
    await chooseFrom(page, 'quick');
    await measureScene(
      page,
      SCENE,
      'toolbar-shows',
      async () => {
        await extend(page, 'quick brown'.length);
        await expect(toolbar).toBeVisible();
      },
      { at: 'above', noShots: true },
    );
    expect(await selected(page)).toBe('quick brown');
    await shot(page, SCENE, 'toolbar');
    // The screenshots in both themes leave the passage chosen and the toolbar up.
    await expect(toolbar).toBeVisible();
    expect(await selected(page)).toBe('quick brown');

    // Alt+Q makes the chip; the caret goes to the request box, whose bottom edge holds.
    await measureScene(
      page,
      SCENE,
      'chip-1',
      async () => {
        await page.keyboard.press('Alt+KeyQ');
        await expect(chips).toHaveCount(1);
      },
      { at: 'above', noShots: true },
    );
    await expect(box).toBeFocused();
    await expect(chips.first()).toContainText('quick brown');
    await chooseFrom(page, 'another');
    await extend(page, 'another passage'.length);
    await expect(toolbar).toBeVisible();
    await measureScene(
      page,
      SCENE,
      'chip-2',
      async () => {
        await page.keyboard.press('Alt+KeyQ');
        await expect(chips).toHaveCount(2);
      },
      { at: 'above', noShots: true },
    );
    await shot(page, SCENE, 'two-chips');

    // Sent by Enter: the request shows its quotes as chips leading back, and its run ends.
    await page.keyboard.type('What do these mean?');
    await waitForStill(page);
    await measureScene(
      page,
      SCENE,
      'send',
      async () => {
        await page.keyboard.press('Enter');
        await expect.poll(() => status(1), { timeout: 30_000 }).toBe('succeeded');
        await expect(page.getByTestId('live-text')).toHaveCount(0);
      },
      { at: 'jump' },
    );
    const sent = page
      .locator('[data-chat-item]')
      .filter({ hasText: 'What do these mean?' })
      .getByRole('button', { name: new RegExp(`^${msg('Composer.goToQuote', { text: '' })}`) });
    await expect(sent).toHaveCount(2);
    await expect(reply).not.toBeInViewport();

    // The sent chip, by the keyboard, leads back: the passage is chosen and marked.
    await sent.first().focus();
    await measureScene(
      page,
      SCENE,
      'led-back',
      async () => {
        await page.keyboard.press('Enter');
        await expect(reply).toBeFocused();
        expect(await selected(page)).toBe('quick brown');
        expect(await page.evaluate(() => CSS.highlights?.has('corral-quote') ?? false)).toBe(true);
      },
      { at: 'jump', noShots: true },
    );
    await expect(reply).toBeInViewport();
    await shot(page, SCENE, 'led-back');
    await checkLabels(page, SCENE, 'led back');
    await page.keyboard.press('Escape');
    await checkChrome(page, SCENE, 'end');
    nothingWaiting(corral.server.coordinator, SCENE);
    expect(corral.errors).toEqual([]);
  });
});
