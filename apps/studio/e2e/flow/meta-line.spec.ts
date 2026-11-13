import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

// A sent message's meta line (features/composer-flow.md "보낸 메시지의 메타 줄"): one line under
// the message that says what became of it, from the run's own record. While an instruction waits,
// is read, cuts a response, is carried to a new request or is not delivered, nothing on screen
// moves and the line keeps its height; a carried request is drawn once (its run row under the
// message it came from); at 480px every meta line is still one line.

const OUT = join(import.meta.dirname, '..', '..', 'test-results', 'flow');
const SHOTS = join(OUT, 'meta-line');

const probeOptions = {
  itemSelector: '[data-chat-item]',
  partSelector: '[data-chat-part]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

function hold() {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { open, opened, reach, reached };
}

const thinking = (seconds: number) => ({
  type: 'thinking' as const,
  thinking: 'Weighing the next step. '.repeat(Math.ceil(seconds * 6)),
});

function expectStill(result: ShiftResult) {
  expect(result.samples.frames, `${result.name}: frames`).toBeGreaterThan(0);
  expect(result.samples.duplicateIds, `${result.name}: duplicate ids`).toBe(0);
  // A meta line is right-aligned and its words change, so its left edge follows their length;
  // its top must hold (its right edge is checked where its words change).
  const moved = result.items.filter((item) =>
    item.id.endsWith('data-chat-part=meta')
      ? item.maxContainerShiftYPx > 1
      : Math.max(item.maxContainerShiftYPx, item.maxContainerShiftXPx) > 1,
  );
  expect(moved, `${result.name}: moved`).toEqual([]);
}

async function shot(page: Page, name: string, target?: Locator) {
  mkdirSync(SHOTS, { recursive: true });
  if (target) await target.scrollIntoViewIfNeeded();
  await waitForStill(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/**
 * Every meta line on the page: one control line high with nothing below its top, nothing
 * overflowing; its last visible glyph at the row's inner right edge (`end`, px off it); the same
 * space on both sides of each dot (`dots`, the largest difference); its status words cut or not.
 */
async function oneLine(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-chat-part="meta"]')].map((meta) => {
      const box = meta.getBoundingClientRect();
      // What is drawn: not the text kept for assistive tech alone.
      const tops = [...meta.querySelectorAll<HTMLElement>('button, time, span')]
        .filter((node) => !node.closest('.sr-only'))
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => rect.bottom - box.top);
      // The status's glyphs, in order: each text node's drawn extent, clipped by its element.
      const status = meta.querySelector('[data-testid="entry-status"]');
      const glyphs: { text: string; left: number; right: number; cut: boolean }[] = [];
      if (status) {
        const walker = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (!parent || parent.closest('.sr-only') || !node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          // The nearest box that draws (a label may be laid out as its contents only).
          let box = parent as HTMLElement | null;
          while (box && box.getBoundingClientRect().width === 0) box = box.parentElement;
          const clip = (box ?? parent).getBoundingClientRect();
          if (rect.width <= 0) continue;
          glyphs.push({
            text: node.textContent.trim(),
            left: Math.max(rect.left, clip.left),
            right: Math.min(rect.right, clip.right),
            cut: rect.right > clip.right + 1,
          });
        }
      }
      const padding = Number.parseFloat(getComputedStyle(meta).paddingRight);
      const last = glyphs.at(-1);
      const dots = glyphs.flatMap((glyph, index) => {
        const before = glyphs[index - 1];
        const after = glyphs[index + 1];
        return glyph.text === '·' && before && after
          ? [Math.abs(glyph.left - before.right - (after.left - glyph.right))]
          : [];
      });
      const cut = glyphs.some((glyph) => glyph.cut);
      return {
        height: Math.round(box.height),
        below: tops.filter((bottom) => bottom > box.height + 1).length,
        overflow: meta.scrollWidth > meta.clientWidth + 1,
        end: last ? Math.round(box.right - padding - last.right) : 0,
        dots: Math.round(Math.max(0, ...dots)),
        cut,
        said: meta.textContent ?? '',
      };
    }),
  );
}

test.use({ live: true, codexLogin: true, streamTokensPerSecond: 30 });

test('the meta line says what became of each message and moves nothing', async ({
  page,
  corral,
}) => {
  test.setTimeout(240_000);
  const first = hold();
  const second = hold();
  const third = hold();
  const fourth = hold();
  const runs = () => [...corral.server.coordinator.listRuns()].reverse();
  const projection = (index: number) => {
    const run = runs()[index];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection : null;
  };
  const directive = (index: number, text: string) =>
    Object.values(projection(index)?.directives ?? {}).find((item) => item.text === text);
  const plan = (revision: number) =>
    fauxToolCall('update_plan', {
      scope: 'execution',
      expectedRevision: revision,
      criteriaVersionId: projection(0)?.currentCriteriaVersionId ?? null,
      items: [{ id: 'look', title: 'Look at the session store', status: 'in_progress' }],
    });
  const reply = 'Reading the store one file at a time.';
  corral.fake?.setResponses([
    async () => {
      first.reach();
      await first.opened;
      return fauxAssistantMessage([plan(0)], { stopReason: 'toolUse' });
    },
    // Held as soon as it is asked for: the join it reads is delivered, and nothing grows.
    async () => {
      second.reach();
      await second.opened;
      return fauxAssistantMessage([{ type: 'text', text: reply }, thinking(30), plan(1)], {
        stopReason: 'toolUse',
      });
    },
    // After the interrupt; its answer ends the role with a join still unread.
    async () => {
      third.reach();
      await third.opened;
      return fauxAssistantMessage([
        { type: 'text', text: 'Looked at session.ts as asked.' },
        thinking(15),
      ]);
    },
    // The carried request's run.
    async () => {
      fourth.reach();
      await fourth.opened;
      return fauxAssistantMessage('Checked the cache.');
    },
  ]);

  await page.setViewportSize({ width: 1280, height: 800 });
  await corral.open('/projects/default');
  await newConversation(page);
  const box = requestBox(page);
  await box.fill('Find why login is slow');
  await box.press('Enter');
  await first.reached;
  await waitForStill(page);
  const items = page.locator('[data-chat-item]');
  const message = (text: string) => items.filter({ hasText: text });
  const status = (text: string) => message(text).getByTestId('entry-status').first();

  // A join with a text file: waiting, then read.
  await page.locator('input[type=file][aria-label="Attach text files"]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Look at the cache first.'),
  });
  await box.fill('Run the tests too');
  await waitForStill(page);
  let probe = createProbe(page, probeOptions);
  await probe.start('join-send');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(status('Run the tests too')).toHaveText(/^Waiting to join/);
  await waitForStill(page);
  expectStill(await probe.stop());
  await expect(message('Run the tests too')).toContainText('notes.txt');
  const joinMeta = message('Run the tests too').locator('[data-chat-part="meta"]');
  const waiting = await joinMeta.boundingBox();
  await shot(page, 'join-waiting-attachment');
  // A started request under the pointer: its time and actions, and nothing said for it.
  await message('Find why login is slow').locator('[data-chat-part="meta"]').hover();
  await shot(page, 'started-hover');
  await expect(status('Find why login is slow')).toHaveText('');
  await page.mouse.move(4, 4);

  probe = createProbe(page, probeOptions);
  await probe.start('join-read');
  first.open();
  await second.reached;
  await expect.poll(() => directive(0, 'Run the tests too')?.status).toBe('delivered');
  await expect(status('Run the tests too')).toHaveText(/^Read/);
  await waitForStill(page);
  expectStill(await probe.stop());
  // The same height, and the same right edge, whatever it says.
  const read = await joinMeta.boundingBox();
  expect(Math.abs((read?.height ?? 0) - (waiting?.height ?? 0))).toBeLessThan(1);
  expect(
    Math.abs((read?.x ?? 0) + (read?.width ?? 0) - (waiting?.x ?? 0) - (waiting?.width ?? 0)),
  ).toBeLessThan(1);
  await shot(page, 'join-read');

  // An interrupt that cuts the streaming response.
  second.open();
  await expect(page.getByTestId('live-text')).toContainText(reply, { timeout: 30_000 });
  await waitForStill(page);
  await box.fill('Look at session.ts instead');
  await box.press('Control+Enter');
  await third.reached;
  await expect.poll(() => directive(0, 'Look at session.ts instead')?.status).toBe('delivered');
  await expect(status('Look at session.ts instead')).toHaveText(/^Interrupted/);
  await shot(page, 'interrupted', message('Look at session.ts instead'));

  // A join the role ends before reading: carried to a new request, drawn once. The answer's
  // words are all on screen first (its thinking keeps the response open meanwhile).
  third.open();
  await expect(page.getByTestId('live-text')).toContainText('Looked at session.ts as asked.', {
    timeout: 30_000,
  });
  await box.fill('Also check the cache');
  await box.press('Enter');
  await expect(status('Also check the cache')).toHaveText(/^Waiting to join/);
  await waitForStill(page);
  await shot(page, 'join-waiting', message('Also check the cache'));
  const before = await items.count();
  // Every distinct thing the line says over the interval, frame by frame.
  await page.evaluate(() => {
    const holder = window as unknown as { __said: string[]; __stop: boolean };
    holder.__said = [];
    holder.__stop = false;
    const frame = () => {
      const line = [...document.querySelectorAll('[data-chat-item]')]
        .find((item) => item.textContent?.includes('Also check the cache'))
        ?.querySelector('[data-testid="entry-status"]')?.textContent;
      if (line != null && holder.__said.at(-1) !== line) holder.__said.push(line);
      if (!holder.__stop) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  probe = createProbe(page, probeOptions);
  await probe.start('carried-start');
  await fourth.reached;
  await expect(status('Also check the cache')).toHaveText('Ended first · started as a new request');
  await waitForStill(page);
  expectStill(await probe.stop());
  const said = await page.evaluate(() => {
    const holder = window as unknown as { __said: string[]; __stop: boolean };
    holder.__stop = true;
    return holder.__said;
  });
  // The run's record says "expired" before the session has the carried request: the line never
  // says "not delivered" meanwhile.
  expect(said.filter((line) => line.startsWith('Not delivered'))).toEqual([]);
  // One more item, the carried request's run row alone, right after; its words once.
  await expect(items).toHaveCount(before + 1);
  await expect(page.getByText('Also check the cache', { exact: true })).toHaveCount(1);
  await expect(items.last().locator('[data-chat-part="meta"]')).toHaveCount(0);
  await expect(items.last().getByTestId('turn-run')).toHaveCount(1);
  await shot(page, 'carried-started');

  // A join to a run that is stopped before reading it: not delivered, with resend.
  await box.fill('Stop after the cache');
  await box.press('Enter');
  await expect(status('Stop after the cache')).toHaveText(/^Waiting to join/);
  const runId = runs()[1]?.runId as string;
  corral.server.coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'cmd_meta_cancel',
    runId,
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'Meta line scene' },
  });
  fourth.open();
  await expect(status('Stop after the cache')).toHaveText(/^Not delivered/, { timeout: 30_000 });
  await expect(
    message('Stop after the cache').getByRole('button', { name: 'Send again', exact: true }),
  ).toBeEnabled();
  await shot(page, 'not-delivered');

  // A refused request: the reason and its actions on the line; the reason opens the raw words.
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  await page.evaluate(async (id) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const response = await fetch(`/api/v1/sessions/${id}/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        intent: 'queue',
        text: 'Write the release notes',
        state: 'refused',
        detail: 'no such model profile: writer-pro',
        refusal: { code: 'TARGET_NOT_FOUND', message: 'no such model profile: writer-pro' },
      }),
    });
    if (!response.ok) throw new Error(`refused entry: ${response.status}`);
  }, sessionId);
  await page.reload();
  await expect(status('Write the release notes')).toContainText('Connect a model');
  await page.mouse.move(4, 4);
  await shot(page, 'refusal', message('Write the release notes'));
  await message('Write the release notes').locator('[data-chat-part="meta"]').hover();
  await shot(page, 'refusal-hover');
  await page.mouse.move(4, 4);
  await message('Write the release notes')
    .getByRole('button', { name: /model profile that is not set up/ })
    .click();
  await expect(page.getByTestId('refusal-raw')).toContainText('TARGET_NOT_FOUND');
  await shot(page, 'refusal-raw');
  await page.keyboard.press('Escape');
  // Focus back on the reason reveals the time and actions; the rest is measured without it.
  // The closing dialog hands focus back first, so wait for that before taking it away.
  await expect(page.getByTestId('refusal-raw')).toBeHidden();
  await expect(
    message('Write the release notes').getByRole('button', {
      name: /model profile that is not set up/,
    }),
  ).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(4, 4);

  // Every meta line is one control line, at 1280 and at 480; its last glyph at its inner edge,
  // a button's as a word's, and the dots evenly spaced. At 1280, not pointed at, nothing is cut.
  const wide = await oneLine(page);
  expect(wide.length).toBeGreaterThan(4);
  for (const { said, cut, ...line } of wide) {
    expect(line, said).toEqual({
      height: wide[0]?.height,
      below: 0,
      overflow: false,
      end: 0,
      dots: 0,
    });
    expect(cut, `${said}: cut at 1280`).toBe(false);
  }
  await page.setViewportSize({ width: 480, height: 800 });
  await waitForStill(page);
  const narrow = await oneLine(page);
  for (const { said, cut: _cut, ...line } of narrow)
    expect(line, said).toEqual({
      height: wide[0]?.height,
      below: 0,
      overflow: false,
      end: 0,
      dots: 0,
    });
  await shot(page, 'narrow-refusal', message('Write the release notes'));
  await shot(page, 'narrow-read', message('Run the tests too'));

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'dark', message('Look at session.ts instead'));
  expect(corral.errors).toEqual([]);
});

// Opened again while its run goes (features/composer-flow.md "계약"): the run is not read as
// ended before the run list says so; the line follows it live and then says its ended record.
test('a page opened again while the run goes follows the instruction to its end', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  const first = hold();
  const second = hold();
  const runs = () => [...corral.server.coordinator.listRuns()].reverse();
  const projection = () => {
    const run = runs()[0];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection : null;
  };
  corral.fake?.setResponses([
    async () => {
      first.reach();
      await first.opened;
      return fauxAssistantMessage(
        [
          fauxToolCall('update_plan', {
            scope: 'execution',
            expectedRevision: 0,
            criteriaVersionId: projection()?.currentCriteriaVersionId ?? null,
            items: [{ id: 'look', title: 'Look at the session store', status: 'in_progress' }],
          }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    async () => {
      second.reach();
      await second.opened;
      return fauxAssistantMessage('Ran the tests as well.');
    },
  ]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await corral.open('/projects/default');
  await newConversation(page);
  const box = requestBox(page);
  await box.fill('Find why login is slow');
  await box.press('Enter');
  await first.reached;
  await waitForStill(page);
  await box.fill('Run the tests too');
  await box.press('Enter');
  const status = page
    .locator('[data-chat-item]')
    .filter({ hasText: 'Run the tests too' })
    .getByTestId('entry-status')
    .first();
  await expect(status).toHaveText(/^Waiting to join/);
  // Opened again while the run goes.
  await page.reload();
  await expect(status).toHaveText(/^Waiting to join/);
  first.open();
  await second.reached;
  await expect(status).toHaveText(/^Read/);
  second.open();
  await expect.poll(() => runs()[0]?.status).toBe('succeeded');
  await expect
    .poll(() => Object.values(projection()?.directives ?? {}).map((item) => item.status))
    .toEqual(['delivered']);
  // Ended: the line says the ended record, and stays.
  await expect(status).toHaveText(/^Read/);
  await page.waitForTimeout(2_000);
  await expect(status).toHaveText(/^Read/);
  expect(corral.errors).toEqual([]);
});
