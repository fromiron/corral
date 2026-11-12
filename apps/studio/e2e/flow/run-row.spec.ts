import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

// The run row's fixed parts (docs/specs/features/composer-flow.md, "튐 없는 본문" rule 3): the
// head line, the body's top edge and the tail line hold their place within 1px while (a) the
// reply's first words replace the wait for them and (b) the run ends after its last words; the
// head line and the body's top edge hold while (c) a run fails after its words. A log the
// person opened stays open, at the same height on every frame, when the windowed timeline
// unmounts its row off screen and mounts it again.
// The reply is one line long, so the body does not grow in either interval: anything that moves
// is the row's own structure. Intervals are bounded by held responses, as in the baseline.

const OUT = join(import.meta.dirname, '..', '..', 'test-results', 'flow');
const SHOTS = join(OUT, 'run-row');
const RESULTS = join(OUT, 'run-row.json');
const PARTS = ['head', 'body', 'tail'] as const;

const probeOptions = {
  itemSelector: '[data-chat-item]',
  partSelector: '[data-chat-part]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

type PartShift = Record<string, { y: number; x: number } | null>;
type Remount = { heightBefore: number; heightsAfter: number[]; sequence: number[] };

function record(name: string, shift: PartShift | Remount) {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, PartShift | Remount> = existsSync(RESULTS)
    ? JSON.parse(readFileSync(RESULTS, 'utf8'))
    : {};
  results[name] = shift;
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

/** Each part's largest move in its container over the interval, or null when it was not there. */
function partShifts(result: ShiftResult, item: string): PartShift {
  return Object.fromEntries(
    PARTS.map((part) => {
      const found = result.items.find(
        (entry) =>
          entry.kind === 'part' && entry.id === `data-chat-item=${item}/data-chat-part=${part}`,
      );
      return [
        part,
        found ? { y: found.maxContainerShiftYPx, x: found.maxContainerShiftXPx } : null,
      ];
    }),
  );
}

async function measure(
  page: Page,
  item: string,
  name: string,
  happen: () => Promise<void>,
  held: readonly (typeof PARTS)[number][] = PARTS,
) {
  const probe = createProbe(page, probeOptions);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-before.png`) });
  await probe.start(name);
  await happen();
  await waitForStill(page);
  const result = await probe.stop();
  await page.screenshot({ path: join(SHOTS, `${name}-after.png`) });
  const shifts = partShifts(result, item);
  record(name, shifts);
  expect(result.samples.frames, `${name}: frames`).toBeGreaterThan(0);
  for (const part of held) {
    const shift = shifts[part];
    expect.soft(shift, `${name}: the ${part} line is there throughout`).not.toBeNull();
    expect
      .soft(shift?.y ?? Number.POSITIVE_INFINITY, `${name}: ${part} vertical`)
      .toBeLessThanOrEqual(1);
    expect
      .soft(shift?.x ?? Number.POSITIVE_INFINITY, `${name}: ${part} horizontal`)
      .toBeLessThanOrEqual(1);
  }
  expect
    .soft(
      result.lost.filter((lost) => lost.includes(`data-chat-item=${item}/`)),
      `${name}: lost`,
    )
    .toEqual([]);
}

test.use({ live: true, codexLogin: true, streamTokensPerSecond: 60 });

test('the run row holds its lines from the first words to the end', async ({ page, corral }) => {
  test.setTimeout(120_000);
  const first = hold();
  const last = hold();
  const line = 'A short answer on one line.';
  const runs = () => [...corral.server.coordinator.listRuns()];
  const status = () => {
    const run = runs()[0];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection.status : null;
  };
  corral.fake?.setResponses([
    async () => {
      first.reach();
      await first.opened;
      const run = runs()[0];
      if (!run) throw new Error('missing run');
      const { projection } = corral.server.coordinator.getSnapshot(run.runId);
      return fauxAssistantMessage(
        [
          { type: 'text', text: line },
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
      last.reach();
      await last.opened;
      return fauxAssistantMessage(line);
    },
  ]);

  await corral.open('/projects/default');
  await newConversation(page);
  await requestBox(page).fill('A request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await first.reached;
  const row = page.locator('[data-chat-item]').filter({ has: page.getByTestId('turn-run') });
  await expect(row).toHaveCount(1);
  const item = (await row.getAttribute('data-chat-item')) as string;
  await waitForStill(page);

  // (a) The wait for the reply gives way to its first words.
  await measure(page, item, 'first-words', async () => {
    first.open();
    await last.reached;
    await expect(row.getByTestId('live-text')).toContainText(line, { timeout: 30_000 });
  });

  // (b) The last words are in and the run ends.
  await measure(page, item, 'run-end', async () => {
    last.open();
    await expect.poll(status, { timeout: 30_000 }).toBe('succeeded');
    await expect(row.getByTestId('live-text')).toHaveCount(0);
    await expect(row.getByTestId('chat-result')).toContainText(line);
    await expect(page.getByRole('region', { name: 'Active run controls' })).toHaveCount(0);
  });
  expect(corral.errors).toEqual([]);
});

test('an opened log stays open, at the same height, when its row leaves the window and returns', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  corral.fake?.setResponses([fauxAssistantMessage('A short answer on one line.')]);
  await corral.open('/projects/default');
  await newConversation(page);
  await requestBox(page).fill('A request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const row = page.locator('[data-chat-item]').filter({ has: page.getByTestId('turn-run') });
  await expect(row.getByTestId('chat-result')).toContainText('A short answer on one line.', {
    timeout: 30_000,
  });
  const item = (await row.getAttribute('data-chat-item')) as string;
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  // Later requests that never ran, enough to push the run's row out of the window.
  await page.evaluate(async (id) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    for (let index = 0; index < 64; index += 1) {
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
  const box = page.getByTestId('chat-timeline');
  const target = page.locator(`[data-chat-item="${item}"]`);
  await page.reload();
  await expect(page.locator('[data-chat-item]').first()).toBeVisible();
  await waitForStill(page);
  // Up to the start by the wheel, as a person reads back (so the timeline stops following).
  await box.hover({ position: { x: 16, y: 200 } });
  for (let step = 0; step < 40 && !(await target.isVisible()); step += 1)
    await page.mouse.wheel(0, -2000);
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  await waitForStill(page);
  // The person opens the run's log.
  const toggle = target.locator('[data-chat-part="head"] button[aria-expanded]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await waitForStill(page);
  const before = (await target.boundingBox())?.height ?? 0;
  expect(before).toBeGreaterThan(0);
  // Away to the end: the row leaves the window and unmounts (focus leaves it first, since a row
  // holding focus may be kept).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let step = 0; step < 40 && (await target.count()) > 0; step += 1)
    await page.mouse.wheel(0, 2000);
  await expect(target).toHaveCount(0);
  // Back by the wheel: the row's height on every frame from its return until it is still.
  await page.evaluate((selector) => {
    const holder = window as unknown as { __rowHeights?: number[]; __rowStop?: boolean };
    holder.__rowHeights = [];
    holder.__rowStop = false;
    const frame = () => {
      const element = document.querySelector(selector);
      if (element) holder.__rowHeights?.push(element.getBoundingClientRect().height);
      if (!holder.__rowStop) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, `[data-chat-item="${item}"]`);
  for (let step = 0; step < 40 && !(await target.isVisible()); step += 1)
    await page.mouse.wheel(0, -2000);
  await expect(target).toBeVisible();
  await waitForStill(page);
  await page.screenshot({ path: join(SHOTS, 'remount-after.png') });
  const heights = await page.evaluate(() => {
    const holder = window as unknown as { __rowHeights?: number[]; __rowStop?: boolean };
    holder.__rowStop = true;
    return holder.__rowHeights ?? [];
  });
  mkdirSync(OUT, { recursive: true });
  record('remount', {
    heightBefore: before,
    heightsAfter: [Math.min(...heights), Math.max(...heights)],
    sequence: heights.filter((value, index) => index === 0 || value !== heights[index - 1]),
  });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.max(...heights) - Math.min(...heights), 'height over the return').toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs((heights[0] ?? 0) - before), 'height right after the return').toBeLessThanOrEqual(
    1,
  );
});

test('a run that fails after its words holds its head and its body’s top edge', async ({
  page,
  corral,
}) => {
  test.setTimeout(120_000);
  const last = hold();
  const line = 'Words shown before the failure.';
  const runs = () => [...corral.server.coordinator.listRuns()];
  const status = () => {
    const run = runs()[0];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection.status : null;
  };
  corral.fake?.setResponses([
    async () => {
      const run = runs()[0];
      if (!run) throw new Error('missing run');
      const { projection } = corral.server.coordinator.getSnapshot(run.runId);
      return fauxAssistantMessage(
        [
          { type: 'text', text: line },
          fauxToolCall('update_plan', {
            scope: 'execution',
            expectedRevision: 0,
            criteriaVersionId: projection.currentCriteriaVersionId,
            items: [{ id: 'answer', title: 'Answer the request', status: 'in_progress' }],
          }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    async () => {
      last.reach();
      await last.opened;
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Fixture failure' });
    },
  ]);

  await corral.open('/projects/default');
  await newConversation(page);
  await requestBox(page).fill('A request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await last.reached;
  const row = page.locator('[data-chat-item]').filter({ has: page.getByTestId('turn-run') });
  await expect(row.getByTestId('live-text')).toContainText(line, { timeout: 30_000 });
  const item = (await row.getAttribute('data-chat-item')) as string;
  await waitForStill(page);

  // (c) The last words are in and the run fails; its end closes the body. The body's height may
  // change, so its tail moves; the head and the body's top edge do not. Whether the words stay
  // depends on their body's lifetime: a complete response's body is released when the run ends
  // (api-contract.md, 산출물 본문 수명), and the client does not show a released body.
  await measure(
    page,
    item,
    'words-to-failure',
    async () => {
      last.open();
      await expect.poll(status, { timeout: 30_000 }).toBe('failed');
      await expect(row.getByTestId('turn-end')).toBeVisible();
    },
    ['head', 'body'],
  );
});
