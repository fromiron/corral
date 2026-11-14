import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import {
  activityLine,
  earlierRequests,
  newConversation,
  requestBox,
  runGoing,
} from '../workbench.ts';
import { waitForStill } from './probe.ts';
import { checkChrome, checkLabels, hold, measure, note, nothingWaiting, shot } from './scene.ts';

// Scene ① idle (docs/guides/testing.md "흐름 장면"): an empty session sends its first request, which
// runs to its end; then, in the session with one finished run, a request is sent by the keyboard,
// its run starts, its reply streams and it ends. No item or session row already on screen moves,
// the tail gap holds while the conversation follows its end, the input line does not move, and
// no target's state name is on screen twice. The activity bar keeps one height before, during
// and after a run, in the light and the dark theme; the fixed areas keep their bounds.

// A second run of the scene first adds requests that never ran, so the conversation is taller
// than its view and follows its end: there the tail gap holds as well.
const VARIANTS = [
  { scene: 'idle', earlier: 0, name: '' },
  { scene: 'idle-tall', earlier: 20, name: ', in a conversation taller than its view' },
];

/** The activity bar's closed line height, in the light and the dark theme. */
async function barHeights(page: Page) {
  const heights: Record<string, number> = {};
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(scheme === 'dark');
    await waitForStill(page, { stillMs: 600 });
    heights[scheme] = (await activityLine(page).boundingBox())?.height ?? 0;
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await waitForStill(page, { stillMs: 400 });
  return heights;
}

test.use({ live: true, codexLogin: true, streamTokensPerSecond: 60 });

for (const { scene: SCENE, earlier, name } of VARIANTS)
  test(`① idle: an empty session sends, and a finished one sends, starts, streams and ends${name}`, async ({
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
      fauxAssistantMessage('A first short answer, so the timeline has items.'),
      // The second run's reply streams and then calls a tool, so the run stays open (held at the
      // next response) until the run-end interval releases it.
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
              text: `${'The reply keeps growing while it streams in. '.repeat(12)}${ending}`,
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

    await page.setViewportSize({ width: 1280, height: 800 });
    await corral.open('/projects/default');
    await newConversation(page);
    await waitForStill(page);
    const empty = await barHeights(page);
    await checkLabels(page, SCENE, 'empty');
    const box = requestBox(page);

    // An empty session's first request: sent, started and ended. The empty session shows its
    // input in the middle (workbench.md "새 대화"), so the first send takes it to the bottom.
    await box.fill('First request');
    await waitForStill(page);
    await measure(
      page,
      SCENE,
      'empty-first-send',
      async () => {
        await box.press('Enter');
        await expect.poll(() => status(0), { timeout: 30_000 }).toBe('succeeded');
        await expect(page.getByTestId('chat-result')).toBeVisible({ timeout: 30_000 });
        await expect(runGoing(page)).toHaveCount(0);
      },
      {
        inputExempt: 'the empty session centres its input (workbench.md "새 대화")',
        tailExempt: 'the empty session centres its input (workbench.md "새 대화")',
      },
    );
    const idle = await barHeights(page);
    await checkLabels(page, SCENE, 'idle');
    await checkChrome(page, SCENE, 'after the first run');
    if (earlier) {
      const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
      await earlierRequests(page, sessionId, earlier);
      await page.reload();
      await expect(page.locator('[data-chat-item]').last()).toContainText(
        `Earlier request ${earlier}.`,
      );
      await waitForStill(page);
      expect(
        await page
          .getByTestId('chat-timeline')
          .evaluate((node) => node.scrollHeight > node.clientHeight + 1),
        'the conversation is taller than its view',
      ).toBe(true);
    }

    // (1) Sent by the keyboard; the run starts and its reply is held back.
    await box.fill('Second request');
    await waitForStill(page);
    await measure(page, SCENE, 'send-to-start', async () => {
      await box.press('Enter');
      await expect.poll(() => runs().length).toBe(2);
      await reply.reached;
      await expect(runGoing(page)).toBeVisible();
    });
    const running = await barHeights(page);
    await checkLabels(page, SCENE, 'running');

    // (2) The reply streams in and its text grows, up to the held next response.
    await measure(page, SCENE, 'streaming', async () => {
      reply.open();
      await finish.reached;
      await expect(page.getByTestId('chat-timeline')).toContainText(ending, { timeout: 30_000 });
    });
    expect(status(1)).toBe('running');

    // (3) The last response is released and the run ends.
    await measure(page, SCENE, 'run-end', async () => {
      finish.open();
      await expect.poll(() => status(1), { timeout: 30_000 }).toBe('succeeded');
      await expect(page.getByTestId('live-text')).toHaveCount(0);
      await expect(runGoing(page)).toHaveCount(0);
    });
    const ended = await barHeights(page);
    await checkLabels(page, SCENE, 'ended');
    note(SCENE, 'bar heights', { empty, idle, running, ended });
    expect(empty.light).toBeGreaterThan(0);
    for (const [name, heights] of Object.entries({ idle, running, ended }))
      expect.soft(heights, `${SCENE} ${name}: activity bar height`).toEqual(empty);
    await checkChrome(page, SCENE, 'end');
    await shot(page, SCENE, 'end');
    nothingWaiting(corral.server.coordinator, SCENE);
    expect(corral.errors).toEqual([]);
  });
