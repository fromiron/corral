import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { createProbe, measureChrome, type ShiftResult, waitForStill } from './probe.ts';

// The composer's height changes (docs/specs/features/composer-flow.md, "튐 없는 본문" rule 1):
// a send starting a run, the run ending, and the input growing and shrinking, at the end and
// while reading earlier messages. Unlike the baseline, this asserts the pass marks of
// docs/plans/unified-flow.md §9: existing items move at most 1px in their container, the tail
// gap changes at most 1px while following the end, items hold their place on screen within 1px
// while reading earlier messages, and the input box's bottom edge does not move. The streaming
// interval is measured and recorded only (the run row's growth is U3's).
// Intervals are bounded by held responses, as in the baseline.

const OUT = join(import.meta.dirname, '..', '..', 'test-results', 'flow');
const SHOTS = join(OUT, 'composer-height');

const probeOptions = {
  itemSelector: '[data-chat-item]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

type Recorded = Record<string, Record<string, Omit<ShiftResult, 'name' | 'items'>>>;
const RESULTS = join(OUT, 'composer-height.json');

/** Adds one interval to the results file; a failed test restarts the worker, so keep the file. */
function record(scene: string, name: string, shift: Omit<ShiftResult, 'name' | 'items'>) {
  mkdirSync(OUT, { recursive: true });
  const results: Recorded = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
  results[scene] = { ...results[scene], [name]: shift };
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
}

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

/** The largest shift of the conversation items alone (sidebar rows move for their own reasons). */
function itemShift(result: ShiftResult, basis: 'Container' | 'Viewport') {
  const values = result.items
    .filter((item) => item.kind === 'item')
    .flatMap((item) => [item[`max${basis}ShiftYPx`], item[`max${basis}ShiftXPx`]]);
  return values.length ? Math.max(...values) : null;
}

async function measure(
  page: Page,
  scene: string,
  name: string,
  happen: () => Promise<void>,
): Promise<ShiftResult> {
  const probe = createProbe(page, probeOptions);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${scene}-${name}-before.png`) });
  await probe.start(name);
  await happen();
  await waitForStill(page);
  const result = await probe.stop();
  await page.screenshot({ path: join(SHOTS, `${scene}-${name}-after.png`) });
  const { name: _name, items: _items, ...shift } = result;
  record(scene, name, {
    ...shift,
    maxContainerShiftPx: itemShift(result, 'Container'),
    maxViewportShiftPx: itemShift(result, 'Viewport'),
  });
  expect(result.samples.frames, `${name}: frames`).toBeGreaterThan(0);
  expect(result.samples.tracked.item, `${name}: conversation items`).toBeGreaterThan(0);
  return result;
}

// Soft, so one run reports every interval's marks; any miss still fails the test.
function expectSteady(result: ShiftResult, place: 'end' | 'reading') {
  const label = `${result.name} (${place})`;
  expect.soft(itemShift(result, 'Container'), `${label}: container shift`).toBeLessThanOrEqual(1);
  expect.soft(result.maxInputBottomChangePx, `${label}: input bottom`).toBe(0);
  if (place === 'end')
    expect.soft(result.maxTailGapChangePx, `${label}: tail gap`).toBeLessThanOrEqual(1);
  else expect.soft(itemShift(result, 'Viewport'), `${label}: screen shift`).toBeLessThanOrEqual(1);
}

const LINES = 'First line\nSecond line\nThird line\nFourth line\nFifth line\nSixth line';

async function growAndShrink(page: Page, scene: string, place: 'end' | 'reading') {
  const box = requestBox(page);
  const before = await box.boundingBox();
  expectSteady(
    await measure(page, scene, `grow-${place}`, async () => {
      await box.fill(LINES);
    }),
    place,
  );
  const grown = await box.boundingBox();
  // The input did grow, upward.
  expect(grown?.height ?? 0).toBeGreaterThan((before?.height ?? 0) + 40);
  expectSteady(
    await measure(page, scene, `shrink-${place}`, async () => {
      await box.fill('');
    }),
    place,
  );
}

const timeline = (page: Page) => page.getByTestId('chat-timeline');

for (const scene of [
  { name: 'short', fillers: 3 },
  { name: 'long', fillers: 64 },
]) {
  test.describe(`${scene.name} conversation`, () => {
    test.use({ live: true, codexLogin: true, streamTokensPerSecond: 60 });

    test(`the composer's height changes without moving the timeline (${scene.name})`, async ({
      page,
      corral,
    }) => {
      test.setTimeout(180_000);
      const reply = hold();
      const finish = hold();
      const ending = 'End of the streamed reply.';
      const runs = () => [...corral.server.coordinator.listRuns()].reverse();
      const status = (index: number) => {
        const run = runs()[index];
        return run ? corral.server.coordinator.getSnapshot(run.runId).projection.status : null;
      };
      corral.fake?.setResponses([
        fauxAssistantMessage('A first short answer.'),
        async () => {
          reply.reach();
          await reply.opened;
          const run = runs()[1];
          if (!run) throw new Error('missing second run');
          const { projection } = corral.server.coordinator.getSnapshot(run.runId);
          return fauxAssistantMessage(
            [
              {
                type: 'text',
                text: `${'The reply keeps growing while it streams in. '.repeat(8)}${ending}`,
              },
              fauxToolCall('update_plan', {
                scope: 'execution',
                expectedRevision: 0,
                criteriaVersionId: projection.currentCriteriaVersionId,
                items: [{ id: 'answer', title: 'Answer the request', status: 'completed' }],
              }),
            ],
            { stopReason: 'toolUse' },
          );
        },
        async () => {
          finish.reach();
          await finish.opened;
          return fauxAssistantMessage('Done.');
        },
      ]);

      await corral.open('/projects/default');
      await newConversation(page);
      const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
      // Earlier requests that never ran, long enough that even the short conversation scrolls.
      await page.evaluate(
        async ({ id, count }) => {
          const { csrfToken } = await (await fetch('/api/v1/session')).json();
          for (let index = 0; index < count; index += 1) {
            const response = await fetch(`/api/v1/sessions/${id}/entries`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
              body: JSON.stringify({
                intent: 'next',
                text: `Earlier request ${index + 1}. ${'This message is long enough to wrap over several lines of the conversation column. '.repeat(4)}`,
                state: 'refused',
              }),
            });
            if (!response.ok) throw new Error(`filler entry: ${response.status}`);
          }
        },
        { id: sessionId, count: scene.fillers },
      );
      await page.reload();
      await expect(page.locator('[data-chat-item]').first()).toBeVisible();

      await requestBox(page).fill('First request');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => status(0), { timeout: 30_000 }).toBe('succeeded');
      await expect(page.getByTestId('chat-result')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Active run controls' })).toHaveCount(0);
      await waitForStill(page);
      const items = await page.locator('[data-chat-item]').count();
      expect(items).toBeGreaterThan(0);
      if (scene.name === 'short') expect(items).toBe(scene.fillers + 1);
      const chrome = await measureChrome(page);
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        join(OUT, `composer-height-${scene.name}-chrome.json`),
        `${JSON.stringify(chrome, null, 2)}\n`,
      );

      // (c) at the end: the input grows to several lines and shrinks back.
      await growAndShrink(page, scene.name, 'end');

      // (a) The request is sent and its run starts; the reply is held back.
      await requestBox(page).fill('Second request');
      await waitForStill(page);
      expectSteady(
        await measure(page, scene.name, 'send-to-start', async () => {
          await page.getByRole('button', { name: 'Send', exact: true }).click();
          await expect.poll(() => runs().length).toBe(2);
          await reply.reached;
          await expect(page.getByRole('region', { name: 'Active run controls' })).toBeVisible();
        }),
        'end',
      );

      // Streaming: recorded only.
      await measure(page, scene.name, 'streaming', async () => {
        reply.open();
        await finish.reached;
        await expect(timeline(page)).toContainText(ending, { timeout: 30_000 });
      });

      // (b) The last response is released and the run ends.
      expectSteady(
        await measure(page, scene.name, 'run-end', async () => {
          finish.open();
          await expect.poll(() => status(1), { timeout: 30_000 }).toBe('succeeded');
          await expect(page.getByTestId('live-text')).toHaveCount(0);
          await expect(page.getByRole('region', { name: 'Active run controls' })).toHaveCount(0);
        }),
        'end',
      );

      // (d) Reading earlier messages: the same growth and shrink leave them where they are.
      // In the margin beside the column: a capped message box under the pointer would keep the
      // wheel to itself.
      await timeline(page).hover({ position: { x: 16, y: 200 } });
      await page.mouse.wheel(0, -900);
      await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
      await waitForStill(page);
      const scrolled = await timeline(page).evaluate(
        (box) => box.scrollHeight - box.clientHeight - box.scrollTop,
      );
      expect(scrolled).toBeGreaterThan(200);
      await growAndShrink(page, scene.name, 'reading');
      expect(corral.errors).toEqual([]);
    });
  });
}
