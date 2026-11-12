import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

// The run row's fixed parts (docs/specs/features/composer-flow.md, "튐 없는 본문" rule 3): the
// head line, the body's top edge and the tail line hold their place within 1px while (a) the
// reply's first words replace the wait for them and (b) the run ends after its last words.
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

function record(name: string, shift: PartShift) {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, PartShift> = existsSync(RESULTS)
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

async function measure(page: Page, item: string, name: string, happen: () => Promise<void>) {
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
  for (const part of PARTS) {
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
