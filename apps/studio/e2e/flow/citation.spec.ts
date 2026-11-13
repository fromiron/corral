import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
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
  // The link that led there is let go of, so the chip leads there again.
  await expect.poll(() => new URL(page.url()).searchParams.get('message')).toBeNull();
  expect(corral.errors).toEqual([]);
});
