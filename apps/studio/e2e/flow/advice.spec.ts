import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import {
  activityBar,
  activityLine,
  newConversation,
  openActivity,
  requestBox,
} from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

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
    .filter({ hasText: 'Advisor' });
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
  await expect(advisorRow.getByRole('button', { name: /^Join/ })).toHaveCount(0);
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
  await expect(advisorRow).toContainText('1 piece of advice delivered');
  await waitForStill(page);
  // The work plan in the panel redraws its step as the role moves from its call to its next
  // request, a few pixels for a moment, and the panel follows it (the plan's own, reported apart).
  // The role rows with the advisor's new count do not move, the bar ends at the height it began
  // at, and the request box never moves.
  const counted = await delivered();
  expect(counted.frames).toBeGreaterThan(0);
  expect(counted.roles, 'advice-delivered: role rows').toBe(0);
  expect(counted.box, 'advice-delivered: request box').toBe(0);
  expect(counted.barEnds[1], 'advice-delivered: bar height after').toBe(counted.barEnds[0]);
  if (counted.bar > 0)
    expect(counted.planMoved, 'advice-delivered: only the plan').toBeGreaterThan(0);
  console.log(`advice-delivered: bar ${counted.bar}px, plan heights ${counted.plan.join(', ')}`);
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
  await expect(activityLine(page)).toContainText('Advisor: final review');
  await waitForStill(page);
  expectComposerStill('final-review', await lastReview());
  expect((await activityLine(page).textContent())?.split('Advisor')).toHaveLength(2);
  await shots(page, 'final-review');
  // Open, the advisor's row says it reviews, and the line does not name it again.
  await openActivity(page);
  await expect(advisorRow).toContainText('Reviewing');
  await expect(activityLine(page)).not.toContainText('Advisor');
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
    /^Advisor·Blocker·The answer blames the cache/,
    { timeout: 30_000 },
  );
  await expect.poll(() => projection()?.status, { timeout: 30_000 }).toBe('succeeded');
  await waitForStill(page);
  expectStill(await probe.stop());
  // The conversation's advisor is named once on the tail.
  expect((await tail.textContent())?.split('Advisor')).toHaveLength(2);
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
