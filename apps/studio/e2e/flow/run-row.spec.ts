import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { templateForWorkspace } from '../../src/demo/templates.ts';
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

// The run row's fixed parts (docs/specs/features/composer-flow.md, "튐 없는 본문" rule 3): the
// head line, the body's top edge and the tail line hold their place within 1px while (a) the
// reply's first words replace the wait for them and (b) the run ends after its last words; the
// head line and the body's top edge hold while (c) a run fails after its words; (d) the head
// keeps one line's height however narrow. A log the person opened stays open, at the same height
// on every frame, when the windowed timeline unmounts its row off screen and mounts it again;
// (e) a body released meanwhile is in no frame of the row's return, and the row keeps the height
// it left with only until it is read again; (f) a conversation turn's kept answer is in every
// frame of its return.
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
type Released = {
  released: number;
  framesWithBody: number;
  frames: number;
  heightBefore: number;
  heldFrames: number;
  heldHeights: [number, number];
  final: { height: number; minHeight: string; gap: number };
};
type HeadLine = { wide: number; narrow: number; tallestValue: number };
type KeptAnswer = { frames: number; framesWithAnswer: number; framesLoading: number };
type Recorded = PartShift | Remount | Released | HeadLine | KeptAnswer;

function record(name: string, shift: Recorded) {
  mkdirSync(OUT, { recursive: true });
  const results: Record<string, Recorded> = existsSync(RESULTS)
    ? JSON.parse(readFileSync(RESULTS, 'utf8'))
    : {};
  results[name] = shift;
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
}

/** Later requests that never ran, enough to push the earlier rows out of the window. */
async function fillers(page: Page, sessionId: string) {
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
}

/** Scrolls the timeline by the wheel, as a person does, until `done`. */
async function wheelUntil(page: Page, delta: number, done: () => Promise<boolean>) {
  await page.getByTestId('chat-timeline').hover({ position: { x: 16, y: 200 } });
  for (let step = 0; step < 60 && !(await done()); step += 1) await page.mouse.wheel(0, delta);
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
    expect.soft(shift, `${name}: the ${part} line is there at the start`).not.toBeNull();
    // On every sampled frame, not only at both ends.
    const track = result.items.find(
      (entry) =>
        entry.kind === 'part' && entry.id === `data-chat-item=${item}/data-chat-part=${part}`,
    );
    expect
      .soft(track?.frames, `${name}: the ${part} line is there throughout`)
      .toBe(result.samples.frames);
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

  // (d) The head keeps one line's height whatever it holds: squeezed far narrower than its
  // values, they give way and none wraps onto a second line.
  const head = row.locator('[data-chat-part="head"]');
  const headLine = (width: string | null) =>
    head.evaluate((node, width) => {
      const element = node as HTMLElement;
      element.style.width = width ?? '';
      element.style.maxWidth = width ?? '';
      const texts = [...element.querySelectorAll('span')].filter(
        (span) => span.childElementCount === 0 && span.textContent?.trim(),
      );
      return {
        height: element.getBoundingClientRect().height,
        tallest: Math.max(...texts.map((span) => span.getBoundingClientRect().height)),
      };
    }, width);
  const wide = await headLine(null);
  const narrow = await headLine('96px');
  await headLine(null);
  // One control line: the tail line's own fixed height, which the head shares.
  const control = (await row.locator('[data-chat-part="tail"]').boundingBox())?.height ?? 0;
  record('head-line', { wide: wide.height, narrow: narrow.height, tallestValue: narrow.tallest });
  expect(Math.abs(wide.height - control), 'head height is one control line').toBeLessThanOrEqual(1);
  expect(Math.abs(narrow.height - wide.height), 'head height when narrow').toBeLessThanOrEqual(1);
  expect(narrow.tallest, 'no head value wraps').toBeLessThanOrEqual(wide.tallest + 1);
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
  await fillers(page, sessionId);
  const target = page.locator(`[data-chat-item="${item}"]`);
  await page.reload();
  await expect(page.locator('[data-chat-item]').first()).toBeVisible();
  await waitForStill(page);
  // Up to the start by the wheel, as a person reads back (so the timeline stops following).
  await wheelUntil(page, -2000, () => target.isVisible());
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
  await wheelUntil(page, 2000, async () => (await target.count()) === 0);
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
  await wheelUntil(page, -2000, () => target.isVisible());
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

// (f) A conversation turn's answer is kept apart from the artifact bodies and never released
// (docs/specs/api-contract.md): a later success does not send it back to loading on its return.
test.describe('a kept answer', () => {
  test.use({ live: true, codexLogin: true, streamTokensPerSecond: 0 });

  test('is in every frame of its row’s return after a later success', async ({ page, corral }) => {
    test.setTimeout(180_000);
    const answer = (mark: string) => `${mark} ${'An answer sentence that wraps. '.repeat(30)}`;
    corral.fake?.setResponses([
      fauxAssistantMessage(answer('FIRST-ANSWER-MARK')),
      fauxAssistantMessage(answer('SECOND-ANSWER-MARK')),
    ]);
    const succeeded = () =>
      [...corral.server.coordinator.listRuns()].filter((run) => run.status === 'succeeded').length;
    await corral.open('/projects/default');
    await newConversation(page);
    await requestBox(page).fill('First request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(succeeded, { timeout: 30_000 }).toBe(1);
    const first = [...corral.server.coordinator.listRuns()][0]?.runId as string;
    const target = page.locator(`[data-testid="run-card-${first}"]`);
    await expect(target).toContainText('FIRST-ANSWER-MARK', { timeout: 30_000 });
    const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
    await fillers(page, sessionId);
    await page.reload();
    await expect(page.locator('[data-chat-item]').first()).toBeVisible();
    await waitForStill(page);
    // Read back to the first answer, then away to the end, where the next request is sent.
    await wheelUntil(page, -2000, () => target.isVisible());
    await expect(target).toContainText('FIRST-ANSWER-MARK', { timeout: 30_000 });
    await waitForStill(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await wheelUntil(page, 2000, async () => (await target.count()) === 0);
    await expect(target).toHaveCount(0);
    await requestBox(page).fill('Second request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(succeeded, { timeout: 30_000 }).toBe(2);
    await expect(page.getByText('SECOND-ANSWER-MARK').first()).toBeVisible({ timeout: 30_000 });
    await waitForStill(page);
    // Back: on every frame from the row's return until it is still, what its body shows.
    await page.evaluate((runId) => {
      const holder = window as unknown as {
        __answerFrames?: { answer: boolean; loading: boolean }[];
        __answerStop?: boolean;
      };
      holder.__answerFrames = [];
      holder.__answerStop = false;
      const tick = () => {
        const row = document.querySelector(`[data-testid="run-card-${runId}"]`);
        const text = row?.textContent ?? '';
        if (row)
          holder.__answerFrames?.push({
            answer: text.includes('FIRST-ANSWER-MARK'),
            loading: text.includes('Loading'),
          });
        if (!holder.__answerStop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, first);
    await wheelUntil(page, -2000, () => target.isVisible());
    await expect(target).toBeVisible();
    await waitForStill(page);
    const frames = await page.evaluate(() => {
      const holder = window as unknown as {
        __answerFrames?: { answer: boolean; loading: boolean }[];
        __answerStop?: boolean;
      };
      holder.__answerStop = true;
      return holder.__answerFrames ?? [];
    });
    await page.screenshot({ path: join(SHOTS, 'kept-answer-after.png') });
    record('kept-answer', {
      frames: frames.length,
      framesWithAnswer: frames.filter((frame) => frame.answer).length,
      framesLoading: frames.filter((frame) => frame.loading).length,
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.answer, 'the answer on the first frame').toBe(true);
    expect(frames.filter((frame) => !frame.answer).length, 'frames without the answer').toBe(0);
    expect(frames.filter((frame) => frame.loading).length, 'frames loading').toBe(0);
  });
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

// A team run whose Output also takes the review: a row with one result block under its kind's
// name, at the same height on every frame of its return.
test.describe('a row with one result block', () => {
  test.use({
    live: false,
    codexLogin: false,
    streamTokensPerSecond: 0,
    agentReply: { reply: () => `# Release plan\n\n${'A recorded result. '.repeat(12)}` },
  });

  test('returns at the height it left with', async ({ page, corral }) => {
    test.setTimeout(180_000);
    const definition = structuredClone(
      templateForWorkspace('research-team', 'one_block').definition,
    );
    for (const node of definition.nodes)
      if (node.type === 'output')
        node.inputBindings.push({ kind: 'task_output', name: 'review', sourceNodeId: 'review' });
    await corral.open('/');
    const started = await page.evaluate(
      async ({ definition }) => {
        const { csrfToken } = await (await fetch('/api/v1/session')).json();
        const call = async (path: string, body: unknown) => {
          const response = await fetch(`/api/v1${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`);
          return response.json();
        };
        const { record } = await call('/corrals', { definition });
        const { session } = await call('/sessions', {
          projectId: 'default',
          title: 'Review the release plan',
          corralId: record.corralId,
        });
        const result = await call('/runs', {
          schemaVersion: '0.1',
          commandId: 'run-row-one-block',
          mode: 'mock',
          sessionId: session.sessionId,
          corralId: record.corralId,
          definitionRevision: record.definitionRevision,
        });
        await call(`/sessions/${session.sessionId}/entries`, {
          intent: 'next',
          text: 'Review the plan',
          state: 'started',
          runId: result.runId,
        });
        return { sessionId: session.sessionId as string, runId: result.runId as string };
      },
      { definition },
    );
    await expect
      .poll(() => corral.server.coordinator.getSnapshot(started.runId).projection.status, {
        timeout: 30_000,
      })
      .toBe('succeeded');
    await fillers(page, started.sessionId);
    await corral.open(`/sessions/${started.sessionId}`);
    await expect(page.locator('[data-chat-item]').first()).toBeVisible();
    await waitForStill(page);
    const target = page.locator(`[data-testid="run-card-${started.runId}"]`);
    await wheelUntil(page, -2000, () => target.isVisible());
    await expect(target).toBeVisible();
    await waitForStill(page);
    await expect(target.locator('details[data-testid="chat-result"]')).toHaveCount(1);
    await expect(target.locator('ul[aria-labelledby]')).toHaveCount(1);
    const item = target.locator('xpath=ancestor::*[@data-chat-item][1]');
    const before = (await item.boundingBox())?.height ?? 0;
    expect(before).toBeGreaterThan(0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await wheelUntil(page, 2000, async () => (await target.count()) === 0);
    await expect(target).toHaveCount(0);
    await page.evaluate((runId) => {
      const holder = window as unknown as { __oneHeights?: number[]; __oneStop?: boolean };
      holder.__oneHeights = [];
      holder.__oneStop = false;
      const frame = () => {
        const element = document
          .querySelector(`[data-testid="run-card-${runId}"]`)
          ?.closest('[data-chat-item]');
        if (element) holder.__oneHeights?.push(element.getBoundingClientRect().height);
        if (!holder.__oneStop) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, started.runId);
    await wheelUntil(page, -2000, () => target.isVisible());
    await expect(target).toBeVisible();
    await waitForStill(page);
    const heights = await page.evaluate(() => {
      const holder = window as unknown as { __oneHeights?: number[]; __oneStop?: boolean };
      holder.__oneStop = true;
      return holder.__oneHeights ?? [];
    });
    record('remount-one-block', {
      heightBefore: before,
      heightsAfter: [Math.min(...heights), Math.max(...heights)],
      sequence: heights.filter((value, index) => index === 0 || value !== heights[index - 1]),
    });
    expect(heights.length).toBeGreaterThan(0);
    expect(
      Math.max(...heights) - Math.min(...heights),
      'height over the return',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((heights[0] ?? 0) - before),
      'height right after the return',
    ).toBeLessThanOrEqual(1);
  });
});

// (e) A failed team run whose partial results a later success of the same session released
// while its row was off screen: no frame of its return shows a released body
// (docs/specs/api-contract.md, 산출물 본문 수명).
let failWriter = true;
test.describe('a released body', () => {
  test.use({
    live: false,
    codexLogin: false,
    streamTokensPerSecond: 0,
    agentReply: {
      reply: () => `# Release plan\n\nRELEASED-BODY-MARK ${'A recorded result. '.repeat(30)}`,
      beforeReply: async (_turn, input) => {
        if (failWriter && input.nodeId === 'write' && input.round === 2)
          throw new Error('Fixture writer failed after the first recorded review');
      },
    },
  });

  test('is in no frame when its row returns', async ({ page, corral }) => {
    test.setTimeout(240_000);
    failWriter = true;
    const template = templateForWorkspace('research-team', 'audit_team');
    await corral.open('/');
    const started = await page.evaluate(async ({ definition }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const call = async (path: string, body: unknown) => {
        const response = await fetch(`/api/v1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`);
        return response.json();
      };
      const { record } = await call('/corrals', { definition });
      const { session } = await call('/sessions', {
        projectId: 'default',
        title: 'Review the release plan',
        corralId: record.corralId,
      });
      const result = await call('/runs', {
        schemaVersion: '0.1',
        commandId: 'run-row-released-first',
        mode: 'mock',
        sessionId: session.sessionId,
        corralId: record.corralId,
        definitionRevision: record.definitionRevision,
      });
      return {
        sessionId: session.sessionId as string,
        runId: result.runId as string,
        corralId: record.corralId as string,
        definitionRevision: record.definitionRevision as number,
      };
    }, template);
    const statusOf = (runId: string) =>
      corral.server.coordinator.getSnapshot(runId).projection.status;
    await expect.poll(() => statusOf(started.runId), { timeout: 30_000 }).toBe('failed');
    // The request that names the run, so its row leads the timeline.
    await page.evaluate(async ({ runId, sessionId }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1/sessions/${sessionId}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({ intent: 'next', text: 'Review the plan', state: 'started', runId }),
      });
      if (!response.ok) throw new Error(`entry setup: ${response.status}`);
    }, started);
    await fillers(page, started.sessionId);
    await corral.open(`/sessions/${started.sessionId}`);
    await expect(page.locator('[data-chat-item]').first()).toBeVisible();
    await waitForStill(page);
    const target = page.locator(`[data-testid="run-card-${started.runId}"]`);
    await wheelUntil(page, -2000, () => target.isVisible());
    await expect(target).toBeVisible();
    await waitForStill(page);
    // Open every partial result, so its body's text is on screen.
    const blocks = target.locator('details[data-testid="chat-result"]');
    const count = await blocks.count();
    for (let index = 0; index < count; index += 1) {
      const block = blocks.nth(index);
      if (!(await block.evaluate((node) => (node as HTMLDetailsElement).open)))
        await block.locator('summary').click();
    }
    await expect(target).toContainText('RELEASED-BODY-MARK', { timeout: 30_000 });
    await waitForStill(page);
    // The height the row leaves with: the row element, which keeps it while it is read again.
    const heightBefore = await target
      .locator('.turn-actions-scope')
      .first()
      .evaluate((node) => node.parentElement?.getBoundingClientRect().height ?? 0);
    expect(heightBefore).toBeGreaterThan(0);
    // Away to the end: the row unmounts.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await wheelUntil(page, 2000, async () => (await target.count()) === 0);
    await expect(target).toHaveCount(0);
    // A later run of the session succeeds; the server releases the earlier run's bodies.
    failWriter = false;
    const second = await page.evaluate(async (first) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch('/api/v1/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({
          schemaVersion: '0.1',
          commandId: 'run-row-released-second',
          mode: 'mock',
          sessionId: first.sessionId,
          corralId: first.corralId,
          definitionRevision: first.definitionRevision,
        }),
      });
      if (!response.ok) throw new Error(`second run: ${response.status}`);
      return (await response.json()).runId as string;
    }, started);
    for (let step = 0; step < 120 && statusOf(second) !== 'succeeded'; step += 1) {
      if (statusOf(second) === 'awaiting_user') {
        const approve = page
          .locator('[data-testid^="approval-"]')
          .getByRole('button', {
            name: /Continue with this version|Confirm as final result|Approve/,
          })
          .first();
        if (await approve.isVisible().catch(() => false)) await approve.click().catch(() => {});
      }
      await page.waitForTimeout(250);
    }
    expect(statusOf(second)).toBe('succeeded');
    await expect(target).toHaveCount(0);
    const released = Object.values(
      corral.server.coordinator.getSnapshot(started.runId).projection.artifacts,
    ).filter((artifact) => artifact.bodyAvailable === false).length;
    expect(released).toBeGreaterThan(0);
    await waitForStill(page);
    // Back: on every frame from the row's return until it is still, whether a body shows.
    type BodyFrame = { body: boolean; height: number; minHeight: string; gap: number };
    await page.evaluate((runId) => {
      const holder = window as unknown as { __bodyFrames?: BodyFrame[]; __bodyStop?: boolean };
      holder.__bodyFrames = [];
      holder.__bodyStop = false;
      const tick = () => {
        const card = document.querySelector(`[data-testid="run-card-${runId}"]`);
        const row = card?.querySelector('.turn-actions-scope')?.parentElement;
        const last = row?.lastElementChild;
        if (card && row && last)
          holder.__bodyFrames?.push({
            body: (card.textContent ?? '').includes('RELEASED-BODY-MARK'),
            height: row.getBoundingClientRect().height,
            minHeight: row.style.minHeight,
            // Room under the row's last block: what a kept height adds to its content.
            gap: row.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom,
          });
        if (!holder.__bodyStop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, started.runId);
    await wheelUntil(page, -2000, () => target.isVisible());
    await expect(target).toBeVisible();
    await waitForStill(page);
    await expect(target).toContainText('no longer available');
    await waitForStill(page);
    const frames = await page.evaluate(() => {
      const holder = window as unknown as { __bodyFrames?: BodyFrame[]; __bodyStop?: boolean };
      holder.__bodyStop = true;
      return holder.__bodyFrames ?? [];
    });
    await page.screenshot({ path: join(SHOTS, 'released-after.png') });
    const held = frames.filter((frame) => frame.minHeight !== '');
    const final = frames.at(-1) ?? { height: 0, minHeight: 'missing', gap: -1 };
    record('released', {
      released,
      framesWithBody: frames.filter((frame) => frame.body).length,
      frames: frames.length,
      heightBefore,
      heldFrames: held.length,
      heldHeights: [
        Math.min(...held.map((frame) => frame.height)),
        Math.max(...held.map((frame) => frame.height)),
      ],
      final: { height: final.height, minHeight: final.minHeight, gap: final.gap },
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => frame.body).length, 'frames showing a released body').toBe(0);
    // While it is read again, the row keeps the height it left with...
    expect(frames[0]?.minHeight, 'a kept height on the first frame').not.toBe('');
    expect(held.length, 'frames at the kept height').toBeGreaterThan(0);
    for (const frame of held)
      expect(Math.abs(frame.height - heightBefore), 'height while read again').toBeLessThanOrEqual(
        1,
      );
    // ...then lets it go: the row is as tall as what it now holds.
    expect(final.minHeight, 'no kept height once read').toBe('');
    expect(Math.abs(final.gap), 'room under the last block once read').toBeLessThanOrEqual(1);
    expect(final.height, 'the row shrinks to its content').toBeLessThan(heightBefore - 1);
  });
});
