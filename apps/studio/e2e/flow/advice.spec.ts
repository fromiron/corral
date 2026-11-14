import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { expect, test } from '../server/harness.ts';
import {
  activityBar,
  activityLine,
  lastRunSucceeded,
  newConversation,
  openActivity,
  requestBox,
  runControls,
} from '../workbench.ts';
import { countVisibleLabels, createProbe, type ShiftResult, waitForStill } from './probe.ts';

// An advisor's advice in the conversation (features/advisor.md 보이는 곳; composer-flow.md "튐 없는
// 본문"): a line in its target's work that changes only its words as its delivery goes on, and
// advice its target never read written into the run row's tail line, which keeps its height. From
// Needs you, the advice's button leads to that row with the advice open (features/inbox.md).

const OUT = join(import.meta.dirname, '..', '..', 'test-results', 'flow');
const SHOTS = process.env.CORRAL_ADVICE_SHOTS ?? join(OUT, 'advice');

const probeOptions = {
  itemSelector: '[data-chat-item]',
  partSelector: '[data-chat-part]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

function gate() {
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

/**
 * The state names on screen keep presence.md's rule: each said once, and every labelled element
 * names what it labels (the advisor's row, the closed line and the advice lines with the rest).
 */
async function labelsKept(page: Page, where: string) {
  await waitForStill(page);
  const { labels, unkeyed } = await countVisibleLabels(page);
  expect(unkeyed, `${where}: labels without a value`).toBe(0);
  const twice = Object.entries(labels).filter(([, { count }]) => count > 1);
  expect(twice, `${where}: a state name on screen twice`).toEqual([]);
  // A label holds the state's name alone; what it does or waits for stands beside it.
  const names = new Set(Object.values(en.Presence.state));
  const said = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-presence-label]')]
      .filter((element) => element.checkVisibility())
      .map((element) => element.textContent?.trim() ?? ''),
  );
  expect(
    said.filter((text) => !names.has(text)),
    `${where}: a label saying more than a state`,
  ).toEqual([]);
}

function expectStill(result: ShiftResult) {
  expect(result.samples.frames, `${result.name}: frames`).toBeGreaterThan(0);
  const moved = result.items.filter(
    (item) => Math.max(item.maxContainerShiftYPx, item.maxContainerShiftXPx) > 1,
  );
  expect(moved, `${result.name}: moved`).toEqual([]);
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await waitForStill(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The same at 1280 light and dark, and 390 wide; back at 1280 light after. */
async function shots(page: Page, name: string) {
  await shot(page, `${name}-1280`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, `${name}-1280-dark`);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 800 });
  await shot(page, `${name}-390`);
  await page.setViewportSize({ width: 1280, height: 800 });
}

/**
 * Follows the composer every frame from now on: the activity bar's height, the open panel's role
 * rows and the request box's place, and the work plan's height apart. The stop function says by
 * how much each changed.
 */
async function watchComposer(page: Page) {
  await page.evaluate(() => {
    const state = {
      bar: [] as number[],
      plan: [] as number[],
      roles: [] as number[],
      box: [] as number[],
      composer: [] as number[],
      stopped: false,
    };
    (window as unknown as { __composer: typeof state }).__composer = state;
    const height = (element: Element | null | undefined) =>
      element?.getBoundingClientRect().height ?? 0;
    const tick = () => {
      if (state.stopped) return;
      const bar = document.querySelector('[data-testid="activity-bar"]');
      // The request box: the composer's combobox named Request.
      const box = [
        ...document.querySelectorAll('[data-testid="chat-composer"] [role="combobox"]'),
      ].find((element) => {
        const named = element.getAttribute('aria-labelledby');
        const label =
          element.getAttribute('aria-label') ??
          (named ? document.getElementById(named)?.textContent : null);
        return label === 'Request';
      });
      if (bar && box) {
        state.bar.push(height(bar));
        state.plan.push(height(bar.querySelector('[data-testid="composer-work-plan"]')));
        state.roles.push(height(bar.querySelector('ul[aria-label="Roles"]')));
        state.box.push(box.getBoundingClientRect().top);
        state.composer.push(height(document.querySelector('[data-testid="chat-composer"]')));
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  return () =>
    page.evaluate(() => {
      const state = (
        window as unknown as {
          __composer: {
            bar: number[];
            plan: number[];
            roles: number[];
            box: number[];
            composer: number[];
            stopped: boolean;
          };
        }
      ).__composer;
      state.stopped = true;
      const range = (values: number[]) => Math.max(...values) - Math.min(...values);
      return {
        frames: state.bar.length,
        bar: range(state.bar),
        barEnds: [state.bar[0] ?? 0, state.bar.at(-1) ?? 0],
        planMoved: range(state.plan),
        plan: [...new Set(state.plan)],
        roles: range(state.roles),
        box: range(state.box),
        tops: [...new Set(state.box)],
        composer: [...new Set(state.composer)],
      };
    });
}

type ComposerWatch = Awaited<ReturnType<Awaited<ReturnType<typeof watchComposer>>>>;

function expectComposerStill(name: string, result: ComposerWatch) {
  expect(result.frames, `${name}: frames`).toBeGreaterThan(0);
  expect(result.bar, `${name}: activity bar height (plan ${result.plan.join(', ')})`).toBe(0);
  expect(
    result.box,
    `${name}: request box ${result.tops.join(', ')} composer ${result.composer.join(', ')}`,
  ).toBe(0);
}

test.use({ live: true, codexLogin: true, streamTokensPerSecond: 60 });

test('advice lines change only their words, and late advice is written into the tail', async ({
  page,
  corral,
}) => {
  test.setTimeout(300_000);
  const fourth = gate();
  const answer = gate();
  const reviewed = gate();
  const finalReview = gate();
  const runs = () => [...corral.server.coordinator.listRuns()].reverse();
  const projection = () => {
    const run = runs()[0];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection : null;
  };
  let lead = 0;
  let reviews = 0;
  let answered = false;
  // One script for both: the advisor answers on its own model (model-b).
  const step = async (
    context: { messages: { role: string }[] },
    _options: unknown,
    _state: unknown,
    model: { id: string },
  ) => {
    if (model.id === 'gpt-test-b') {
      // A review advises once, then has nothing more to say.
      if (context.messages.at(-1)?.role === 'toolResult')
        return fauxAssistantMessage('Nothing more.');
      reviews += 1;
      if (reviews === 1) {
        reviewed.reach();
        await reviewed.opened;
        // A review while the role is still answering has nothing to add; the last one, after it
        // answered, gives the blocker.
      } else if (!answered) return fauxAssistantMessage('Nothing to add.');
      else await finalReview.opened;
      return fauxAssistantMessage(
        [
          reviews === 1
            ? fauxToolCall('advise', {
                severity: 'concern',
                note: 'The plan never measures the slow path.\nTime the login before changing it.',
              })
            : fauxToolCall('advise', {
                severity: 'blocker',
                note: '\n\nThe answer blames the cache without a measurement. Measure the login request before and after the change, or the fix may not touch the slow path at all.',
              }),
        ],
        { stopReason: 'toolUse' },
      );
    }
    lead += 1;
    const plan = fauxToolCall('update_plan', {
      scope: 'execution',
      expectedRevision: lead - 1,
      criteriaVersionId: projection()?.currentCriteriaVersionId ?? null,
      items: [{ id: 'look', title: 'Look at the login path', status: 'in_progress' }],
    });
    // The fourth request waits for the first advice, so the fifth reads it; the fifth's answer
    // waits while the advisor watches with its advice delivered.
    if (lead === 4) await fourth.opened;
    if (lead <= 4) return fauxAssistantMessage([plan], { stopReason: 'toolUse' });
    if (lead === 5) await answer.opened;
    answered = true;
    return fauxAssistantMessage('The login waits on the session cache.');
  };
  corral.fake?.setResponses(Array.from({ length: 24 }, () => step as never));

  await page.setViewportSize({ width: 1280, height: 800 });
  const needsYou = () => page.getByRole('link', { name: 'Needs you', exact: true }).first().click();
  await corral.open('/projects/default');
  await newConversation(page);
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  // The conversation's own advisor (features/advisor.md 두는 곳 › 대화), on the session.
  await page.evaluate(async (id) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const session = await (await fetch(`/api/v1/sessions/${id}`)).json();
    const response = await fetch(`/api/v1/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        advisor: { modelProfile: 'model-b' },
        expectedRevision: session.session?.revision ?? session.revision,
      }),
    });
    if (!response.ok) throw new Error(`advisor ${response.status}`);
  }, sessionId);

  const box = requestBox(page);
  await box.fill('Find why login is slow');
  await box.press('Enter');
  const row = page.locator('[data-chat-item]').last();
  const toggle = row.locator('[data-chat-part="head"] button[aria-expanded]');
  const adviceLine = row.locator('.turn-process-row [data-advice-line]');
  await reviewed.reached;
  await waitForStill(page);

  // The activity bar's advisor row, after the roles: reviewing, and no Join (features/advisor.md).
  const advisorRow = activityBar(page)
    .locator('[data-activity-role]')
    .filter({ hasText: 'Outrider' });
  const fold = async () => {
    await activityBar(page).locator('[data-activity-toggle]').click();
    await expect(activityBar(page).locator('[data-activity-toggle]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await waitForStill(page);
  };
  await openActivity(page);
  await expect(advisorRow).toContainText('Reviewing');
  // Only a review turns its mark.
  await expect(advisorRow.locator('svg').first()).toHaveClass(/animate-spin/);
  await expect(advisorRow.getByRole('button', { name: /^Join/ })).toHaveCount(0);
  await labelsKept(page, 'advisor-reviewing');
  await shots(page, 'advisor-reviewing');
  await fold();

  // The first review's concern comes into the implementer's work: nothing on screen moves.
  let probe = createProbe(page, probeOptions);
  await probe.start('advice-admitted');
  reviewed.open();
  await expect(adviceLine).toHaveCount(1, { timeout: 30_000 });
  await expect(adviceLine.locator('[data-advice-state]')).toHaveText(/^Waiting to join/);
  await waitForStill(page);
  expectStill(await probe.stop());
  // Opened by the person: the line waits to be read, and opens to its words.
  await toggle.click();
  await shot(page, 'line-waiting-1280');
  await adviceLine.click();
  // Open, the words begin with the first line: the line does not say it again.
  await expect(adviceLine).not.toContainText('The plan never measures');
  await shot(page, 'line-waiting-open-1280');
  await adviceLine.click();

  // Read by the next request: the same line where it was in its row (the log grows under it as
  // the work goes on, and the conversation follows its end), only its words changed.
  const head = row.locator('[data-chat-part="head"]');
  const offset = async () => {
    const [line, top] = [await adviceLine.boundingBox(), await head.boundingBox()];
    return { y: (line?.y ?? 0) - (top?.y ?? 0), height: line?.height ?? 0 };
  };
  // The activity panel open meanwhile: the advisor's count comes on its row, and the bar keeps its
  // height and the request box its place.
  await openActivity(page);
  await waitForStill(page);
  const delivered = await watchComposer(page);
  const before = await offset();
  fourth.open();
  await expect(adviceLine.locator('[data-advice-state]')).toHaveText('Read', { timeout: 30_000 });
  await waitForStill(page);
  const after = await offset();
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
  // A review of the new work has nothing to add: the advisor watches again, its count kept.
  await expect(advisorRow).toContainText('Watching', { timeout: 30_000 });
  // Watching makes no model request: its mark stands still.
  await expect(advisorRow.locator('svg').first()).not.toHaveClass(/animate-spin/);
  await expect(advisorRow).toContainText('1 piece of advice delivered');
  await waitForStill(page);
  // The role rows with the advisor's new count do not move, nor does the work plan as the role
  // moves from its call to its next request: the bar keeps its height and the request box its
  // place.
  const counted = await delivered();
  expect(counted.frames).toBeGreaterThan(0);
  expect(counted.roles, 'advice-delivered: role rows').toBe(0);
  expect(counted.box, 'advice-delivered: request box').toBe(0);
  expect(counted.bar, `advice-delivered: bar (plan ${counted.plan.join(', ')})`).toBe(0);
  await labelsKept(page, 'advisor-watching');
  await shots(page, 'advisor-watching');
  await fold();
  await shot(page, 'line-read-1280');
  await toggle.click();
  await waitForStill(page);

  // The role answers and ends; the advisor's last review is left. The closed line says so, once,
  // and the bar keeps its height and the request box its place.
  const lastReview = await watchComposer(page);
  answer.open();
  await expect(activityBar(page)).toHaveAttribute('data-line', 'advisor', { timeout: 30_000 });
  await expect(activityLine(page)).toContainText('Outrider: final review');
  await waitForStill(page);
  expectComposerStill('final-review', await lastReview());
  expect((await activityLine(page).textContent())?.split('Outrider')).toHaveLength(2);
  await labelsKept(page, 'final-review');
  await shots(page, 'final-review');
  // Open, the advisor's row says it reviews, and the line does not name it again.
  await openActivity(page);
  await expect(advisorRow).toContainText('Reviewing');
  await expect(activityLine(page)).not.toContainText('Outrider');
  await labelsKept(page, 'final-review-open');
  await shot(page, 'final-review-open-1280');
  await fold();

  // The final review's blocker comes after the role ended: written into the tail's own line,
  // and nothing on screen moves.
  const tail = row.locator('[data-chat-part="tail"]');
  await expect(tail.locator('[data-advice-line]')).toHaveCount(0);
  probe = createProbe(page, probeOptions);
  await probe.start('advice-tail');
  finalReview.open();
  await expect(tail.locator('[data-advice-line]')).toHaveText(
    /^Outrider·Blocker·The answer blames the cache/,
    { timeout: 30_000 },
  );
  await expect.poll(() => projection()?.status, { timeout: 30_000 }).toBe('succeeded');
  await waitForStill(page);
  expectStill(await probe.stop());
  // The conversation's advisor is named once on the tail.
  expect((await tail.textContent())?.split('Outrider')).toHaveLength(2);
  await labelsKept(page, 'tail-one');
  await shot(page, 'tail-one-1280');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'tail-one-1280-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 800 });
  await shot(page, 'tail-one-390');
  await page.setViewportSize({ width: 1280, height: 800 });

  // Needs you lists it; its button leads to the row with the advice open, and seeing it clears it.
  await needsYou();
  const item = page.locator('[data-inbox-row]').filter({ hasText: 'Blocker' });
  await expect(item).toHaveCount(1, { timeout: 30_000 });
  await item.click();
  await page.getByRole('link', { name: 'Open advice' }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`));
  const arrived = page.locator('[data-chat-part="tail"] [data-advice-line]').last();
  await expect(arrived).toHaveAttribute('aria-expanded', 'true');
  await expect(arrived).not.toContainText('The answer blames');
  await shot(page, 'arrived-1280');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'arrived-1280-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 800 });
  await shot(page, 'arrived-390');
  await page.setViewportSize({ width: 1280, height: 800 });
  await needsYou();
  await expect(page.locator('[data-inbox-row]').filter({ hasText: 'Blocker' })).toHaveCount(0, {
    timeout: 30_000,
  });
  expect(corral.errors).toEqual([]);
});

/** The conversation's own advisor on the session, answering on model-b. */
async function sessionAdvisor(page: Page, sessionId: string) {
  await page.evaluate(async (id) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const session = await (await fetch(`/api/v1/sessions/${id}`)).json();
    const response = await fetch(`/api/v1/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        advisor: { modelProfile: 'model-b' },
        expectedRevision: session.session?.revision ?? session.revision,
      }),
    });
    if (!response.ok) throw new Error(`advisor ${response.status}`);
  }, sessionId);
}

/** An answer far longer than the screen. */
const LONG_ANSWER = Array.from(
  { length: 60 },
  (_, index) =>
    `Step ${index + 1}: the login request waits on the session cache before it reads the user row, so each sign-in pays for a cache round trip it does not need.`,
).join('\n\n');

test.describe('advice a role never read', () => {
  test.use({ streamTokensPerSecond: 0 });

  test('stays where it was drawn, and its button brings its words above the composer', async ({
    page,
    corral,
  }) => {
    test.setTimeout(300_000);
    const reviewed = gate();
    const final = gate();
    const runs = () => [...corral.server.coordinator.listRuns()].reverse();
    const projection = () => {
      const run = runs()[0];
      return run ? corral.server.coordinator.getSnapshot(run.runId).projection : null;
    };
    let lead = 0;
    let reviews = 0;
    const step = async (
      context: { messages: { role: string }[] },
      _options: unknown,
      _state: unknown,
      model: { id: string },
    ) => {
      if (model.id === 'gpt-test-b') {
        if (context.messages.at(-1)?.role === 'toolResult')
          return fauxAssistantMessage('Nothing more.');
        reviews += 1;
        // The first review gives a concern and a note; any later one has nothing to add.
        if (reviews > 1) return fauxAssistantMessage('Nothing to add.');
        reviewed.reach();
        await reviewed.opened;
        return fauxAssistantMessage(
          [
            fauxToolCall('advise', {
              severity: 'concern',
              note: 'The answer never times the login.\nMeasure it before changing the cache.',
            }),
            fauxToolCall('advise', {
              severity: 'nit',
              note: 'Name the cache the login waits on.',
            }),
          ],
          { stopReason: 'toolUse' },
        );
      }
      lead += 1;
      // Once the advisor reviews, the role's next request is its answer: prepared before the
      // concern arrives, so the role ends without reading it.
      if (reviews === 0)
        return fauxAssistantMessage(
          [
            fauxToolCall('update_plan', {
              scope: 'execution',
              expectedRevision: lead - 1,
              criteriaVersionId: projection()?.currentCriteriaVersionId ?? null,
              items: [{ id: 'look', title: 'Look at the login path', status: 'in_progress' }],
            }),
          ],
          { stopReason: 'toolUse' },
        );
      final.reach();
      await final.opened;
      return fauxAssistantMessage(LONG_ANSWER);
    };
    corral.fake?.setResponses(Array.from({ length: 24 }, () => step as never));
    const opened: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/executions\/[^/]+\/opened$/.test(request.url()))
        opened.push(request.url());
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await corral.open('/projects/default');
    await newConversation(page);
    const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
    await sessionAdvisor(page, sessionId);
    const box = requestBox(page);
    await box.fill('Find why login is slow');
    await box.press('Enter');
    const row = page.locator('[data-chat-item]').last();
    const head = row.locator('[data-chat-part="head"]');
    const lines = row.locator('.turn-process-row [data-advice-line]');
    const adviceLine = lines.filter({ hasText: 'Concern' });
    const noteLine = lines.filter({ hasText: 'Note' });
    await Promise.all([reviewed.reached, final.reached]);

    // The work log open: the concern comes into the role's work, waiting for a request that will
    // not come.
    await head.locator('button[aria-expanded]').click();
    reviewed.open();
    await expect(adviceLine.locator('[data-advice-state]')).toHaveText(/^Waiting to join/, {
      timeout: 30_000,
    });
    await expect(noteLine.locator('[data-advice-state]')).toHaveText(/^Waiting to join/);
    await waitForStill(page);
    const place = async () => {
      const [line, top] = [await adviceLine.boundingBox(), await head.boundingBox()];
      return { y: (line?.y ?? 0) - (top?.y ?? 0), height: line?.height ?? 0 };
    };
    const before = await place();
    const noteBefore = await noteLine.boundingBox();
    const rowBefore = await head.boundingBox();

    // The role answers and ends: the line stays where it stood and says it was not delivered;
    // the tail says it too.
    final.open();
    await expect.poll(() => projection()?.status, { timeout: 60_000 }).toBe('succeeded');
    await expect(lines).toHaveCount(2);
    await expect(adviceLine.locator('[data-advice-state]')).toHaveText('Not delivered');
    // The note's line stays as well, saying the same; it is the tail's and Needs you's no more.
    await expect(noteLine.locator('[data-advice-state]')).toHaveText('Not delivered');
    await waitForStill(page);
    const [noteAfter, rowAfter] = [await noteLine.boundingBox(), await head.boundingBox()];
    expect(
      Math.abs(
        (noteAfter?.y ?? 0) - (rowAfter?.y ?? 0) - ((noteBefore?.y ?? 0) - (rowBefore?.y ?? 0)),
      ),
      'not-delivered: note place',
    ).toBeLessThanOrEqual(1);
    // Brought into view for the record of it; nothing is measured after this.
    await noteLine.scrollIntoViewIfNeeded();
    await shot(page, 'note-not-delivered-1280');
    const after = await place();
    expect(Math.abs(after.y - before.y), 'not-delivered: line place').toBeLessThanOrEqual(1);
    expect(
      Math.abs(after.height - before.height),
      'not-delivered: line height',
    ).toBeLessThanOrEqual(1);
    const tail = row.locator('[data-chat-part="tail"] [data-advice-line]');
    await expect(tail).toHaveText(/^Outrider·Concern·The answer never times the login/);
    await expect(row.locator('[data-chat-part="tail"]')).not.toContainText('Name the cache');
    const runId = projection()?.runId as string;

    // From Needs you, its button: the advice opens on the row and its words come into view
    // above the composer, though the answer is longer than the screen.
    await page.getByRole('link', { name: 'Needs you', exact: true }).first().click();
    const item = page.locator('[data-inbox-row]').filter({ hasText: 'Concern' });
    await expect(item).toHaveCount(1, { timeout: 30_000 });
    await expect(
      page.locator('[data-inbox-row]').filter({ hasText: 'Name the cache' }),
    ).toHaveCount(0);
    await item.click();
    await page.getByRole('link', { name: 'Open advice' }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`));
    const arrived = page.locator('[data-chat-item]').last();
    const arrivedLine = arrived.locator('[data-chat-part="tail"] [data-advice-line]');
    const words = arrived.locator('[data-advice-text]').last();
    await expect(arrivedLine).toHaveAttribute('aria-expanded', 'true');
    await waitForStill(page);
    const inView = async () => {
      const [shown, timeline, composer] = await Promise.all([
        words.boundingBox(),
        page.getByTestId('chat-timeline').boundingBox(),
        page.getByTestId('chat-composer').boundingBox(),
      ]);
      return {
        top: (shown?.y ?? 0) - (timeline?.y ?? 0),
        bottom: (composer?.y ?? 0) - ((shown?.y ?? 0) + (shown?.height ?? 0)),
      };
    };
    const shown = await inView();
    expect(shown.top, 'arrival: words below the view top').toBeGreaterThanOrEqual(0);
    expect(shown.bottom, 'arrival: words above the composer').toBeGreaterThanOrEqual(0);
    // No mark of the arrival is left: not on the row, not in the address.
    expect(new URL(page.url()).searchParams.get('advice')).toBeNull();
    await expect(page.locator('[data-chat-item][aria-current="location"]')).toHaveCount(0);
    await expect.poll(() => opened.length, { timeout: 10_000 }).toBe(1);
    await shot(page, 'arrived-long-1280');
    await page.getByRole('link', { name: 'Needs you', exact: true }).first().click();
    await expect(page.locator('[data-inbox-row]').filter({ hasText: 'Concern' })).toHaveCount(0, {
      timeout: 30_000,
    });

    // Back to the conversation: the address no longer asks, so the advice is not opened again.
    await page.goBack();
    await waitForStill(page);
    expect(new URL(page.url()).searchParams.get('advice')).toBeNull();
    await expect(arrivedLine).toHaveAttribute('aria-expanded', 'false');
    // Arrived at again in the same conversation, its row already drawn: it opens again.
    await page.evaluate(
      ({ id, run }) => {
        window.history.pushState(window.history.state, '', `/sessions/${id}?advice=${run}`);
        window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
      },
      { id: sessionId, run: runId },
    );
    await expect(arrivedLine).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => new URL(page.url()).searchParams.get('advice')).toBeNull();
    // Folded again, Back does not arrive again.
    await arrivedLine.click();
    await expect(arrivedLine).toHaveAttribute('aria-expanded', 'false');
    await page.goBack();
    await waitForStill(page);
    expect(new URL(page.url()).searchParams.get('advice')).toBeNull();
    await expect(arrivedLine).toHaveAttribute('aria-expanded', 'false');
    expect(corral.errors).toEqual([]);
  });

  test('a stop during the last review ends the review, and the run is done', async ({
    page,
    corral,
  }) => {
    test.setTimeout(180_000);
    const last = gate();
    const step = async (
      context: { messages: { role: string }[] },
      _options: unknown,
      _state: unknown,
      model: { id: string },
    ) => {
      if (model.id !== 'gpt-test-b') return fauxAssistantMessage('The login waits on the cache.');
      if (context.messages.at(-1)?.role === 'toolResult')
        return fauxAssistantMessage('Nothing more.');
      // The last review hangs until it is stopped.
      last.reach();
      await last.opened;
      return fauxAssistantMessage('Nothing to add.');
    };
    corral.fake?.setResponses(Array.from({ length: 8 }, () => step as never));
    await page.setViewportSize({ width: 1280, height: 800 });
    await corral.open('/projects/default');
    await newConversation(page);
    const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
    await sessionAdvisor(page, sessionId);
    const box = requestBox(page);
    await box.fill('Find why login is slow');
    await box.press('Enter');
    await last.reached;
    await expect(activityBar(page)).toHaveAttribute('data-line', 'advisor', { timeout: 30_000 });
    await expect(activityLine(page)).toContainText('Outrider: final review');
    // The tool line says nothing of why no role takes an instruction: Send says it.
    await expect(page.getByTestId('chat-composer')).not.toContainText('No role takes instructions');
    await waitForStill(page);
    await shot(page, 'final-review-line-1280');
    // Stop asks nothing: only the review is left to stop.
    await openActivity(page);
    await runControls(page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Cancel whole run', exact: true })).toHaveCount(
      0,
    );
    last.open();
    await expect(lastRunSucceeded(page)).toBeVisible({ timeout: 30_000 });
    const row = page.locator('[data-chat-item]').last();
    await expect(row.locator('[data-chat-part="head"]')).not.toContainText(/Cancelled|Stopped/);
    await expect(row).not.toContainText(/Partial result|Retry request/);
    await expect(activityLine(page)).not.toContainText(
      /unconfirmed outcome|usage was not reported/,
    );
    // Settled (past the sidebar's grace for an ended run): the sidebar marks it done, and the
    // composer holds no empty band where the panel's sections were.
    const sideMark = page.locator(
      `[data-session-row="${sessionId}"] [data-session-line="state"] svg`,
    );
    await expect
      .poll(async () => (await sideMark.first().getAttribute('class')) ?? '', { timeout: 10_000 })
      .not.toMatch(/animate-spin/);
    await expect(activityBar(page).locator('[data-activity-toggle]')).toHaveCount(0);
    await waitForStill(page);
    const band = await page.evaluate(() => {
      const card = document.querySelector('[data-slot="composer-card"]');
      const line = document.querySelector('[data-activity-bar] > div');
      return (line?.getBoundingClientRect().top ?? 0) - (card?.getBoundingClientRect().top ?? 0);
    });
    expect(band, 'settled: nothing above the line in the composer').toBeLessThanOrEqual(1);
    await shot(page, 'stopped-review-done-1280');
    expect(corral.errors).toEqual([]);
  });
});
