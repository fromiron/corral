import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
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

test.use({ live: true, codexLogin: true, streamTokensPerSecond: 60 });

test('advice lines change only their words, and late advice is written into the tail', async ({
  page,
  corral,
}) => {
  test.setTimeout(240_000);
  const fourth = gate();
  const reviewed = gate();
  const finalReview = gate();
  const runs = () => [...corral.server.coordinator.listRuns()].reverse();
  const projection = () => {
    const run = runs()[0];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection : null;
  };
  let lead = 0;
  let reviews = 0;
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
      } else await finalReview.opened;
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
      items: [{ id: 'look', title: `Look at the login path (${lead})`, status: 'in_progress' }],
    });
    // The fourth request waits for the first advice, so the fifth reads it.
    if (lead === 4) await fourth.opened;
    if (lead <= 4) return fauxAssistantMessage([plan], { stopReason: 'toolUse' });
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
  await shot(page, 'line-waiting-open-1280');
  await adviceLine.click();

  // Read by the next request: the same line where it was in its row (the log grows under it as
  // the work goes on, and the conversation follows its end), only its words changed.
  const head = row.locator('[data-chat-part="head"]');
  const offset = async () => {
    const [line, top] = [await adviceLine.boundingBox(), await head.boundingBox()];
    return { y: (line?.y ?? 0) - (top?.y ?? 0), height: line?.height ?? 0 };
  };
  const before = await offset();
  fourth.open();
  await expect(adviceLine.locator('[data-advice-state]')).toHaveText('Read', { timeout: 30_000 });
  await waitForStill(page);
  const after = await offset();
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
  await shot(page, 'line-read-1280');
  await toggle.click();
  await waitForStill(page);

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
