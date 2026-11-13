import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTextAttachment } from '@corral/core';
import { fauxAssistantMessage } from '@corral/server/testing';
import type { Locator, Page } from '@playwright/test';
import { expect, type Harness, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

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

const FIRST = 'The quick brown fox jumps over the lazy dog.';
const SECOND = 'A second paragraph holds another passage worth quoting.';

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
const selected = (page: Page) => page.evaluate(() => document.getSelection()?.toString() ?? '');

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

/** A conversation with one reply, and requests that never ran after it to push it away. */
async function conversation(page: Page, corral: Harness, later: number) {
  await corral.open('/projects/default');
  await newConversation(page);
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  await requestBox(page).fill('Tell me about the fox');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const run = () => [...corral.server.coordinator.listRuns()][0];
  await expect
    .poll(() => {
      const found = run();
      return found ? corral.server.coordinator.getSnapshot(found.runId).projection.status : null;
    })
    .toBe('succeeded');
  const body = page.locator('[data-reply-body]').first();
  await expect(body).toBeVisible();
  const runId = run()?.runId as string;
  const modelCallId = (await body.getAttribute('data-model-call-id')) as string;
  const drawn = (await body.textContent()) ?? '';
  if (later) await requests(page, sessionId, later);
  return { sessionId, runId, modelCallId, drawn };
}
/** Requests that never ran, long enough to wrap. */
const requests = (page: Page, sessionId: string, count: number) =>
  page.evaluate(
    async ({ id, count }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      for (let index = 0; index < count; index += 1) {
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
    },
    { id: sessionId, count },
  );
/** A message sent with a quote of the reply: of `text` at `at` in the drawn reply. */
async function sendQuote(
  page: Page,
  reply: { sessionId: string; runId: string; modelCallId: string; drawn: string },
  text: string,
  at: number,
) {
  const attachment = createTextAttachment('quote.txt', 'text/plain', text, {
    kind: 'reply',
    runId: reply.runId,
    modelCallId: reply.modelCallId,
    start: at,
    end: at + text.length,
    prefix: reply.drawn.slice(Math.max(0, at - 32), at),
    suffix: reply.drawn.slice(at + text.length, at + text.length + 32),
  });
  await page.evaluate(
    async ({ id, attachment }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1/sessions/${id}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({
          intent: 'next',
          text: 'About the passage',
          state: 'refused',
          attachments: [attachment],
        }),
      });
      if (!response.ok) throw new Error(`entry: ${response.status}`);
    },
    { id: reply.sessionId, attachment },
  );
}
const sentChip = (page: Page) =>
  page
    .locator('[data-chat-item]')
    .filter({ hasText: 'About the passage' })
    .getByRole('button', { name: /^Go to the quoted passage/ });
const NOT_FOUND = "Couldn't find the passage in the reply";

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
