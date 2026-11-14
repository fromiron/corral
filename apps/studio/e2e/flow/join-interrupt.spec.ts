import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { waitForStill } from './probe.ts';
import {
  checkChrome,
  checkLabels,
  hold,
  measure,
  msg,
  note,
  nothingWaiting,
  shot,
} from './scene.ts';

// Scene ③ join and interrupt (docs/plans/unified-flow.md §9; features/composer-flow.md "전송",
// "보낸 메시지의 메타 줄"), by the keyboard alone. While a run's response is held, a message sent
// with the send key waits to join; released, its meta line says it was read. A second message
// sent with the interrupt key cuts the streaming reply and is delivered; the cut words stay where
// they stood. A third message joins a role that ends before reading it: it starts a new request
// and its line says so. No item or session row already on screen moves, the input line does not
// move, and no target's state name is on screen twice.
// The responses are held as in meta-line.spec.ts and send-model.spec.ts: a reply's words are all
// on screen before an interval starts, and thinking after them keeps the response open.

const SCENE = 'join-interrupt';

/** A meta line that starts with `words` (the role it names may follow). */
const starts = (words: string) => new RegExp(`^${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

const thinking = (seconds: number) => ({
  type: 'thinking' as const,
  thinking: 'Weighing the next step. '.repeat(Math.ceil(seconds * 6)),
});

/** Where the cut reply stands in the conversation's scroll content. */
function cutPlace(page: Page) {
  return page.getByTestId('stopped-text').evaluate((node) => {
    const timeline = node.closest('[data-testid="chat-timeline"]');
    if (!timeline) return null;
    const box = node.getBoundingClientRect();
    const origin = timeline.getBoundingClientRect();
    return {
      top: Math.round((box.top - origin.top + timeline.scrollTop) * 10) / 10,
      height: Math.round(box.height * 10) / 10,
    };
  });
}

test.use({ live: true, codexLogin: true, streamTokensPerSecond: 30 });

test('③ join, interrupt and a join carried to a new request, by the keyboard alone', async ({
  page,
  corral,
}) => {
  test.setTimeout(240_000);
  const first = hold();
  const second = hold();
  const third = hold();
  const requests: string[] = [];
  const runs = () => [...corral.server.coordinator.listRuns()].reverse();
  const projection = (index: number) => {
    const run = runs()[index];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection : null;
  };
  const directive = (text: string) =>
    Object.values(projection(0)?.directives ?? {}).find((item) => item.text === text);
  const plan = (revision: number) =>
    fauxToolCall('update_plan', {
      scope: 'execution',
      expectedRevision: revision,
      criteriaVersionId: projection(0)?.currentCriteriaVersionId ?? null,
      items: [{ id: 'look', title: 'Look at the session store', status: 'in_progress' }],
    });
  const reply = 'Reading the store one file at a time.';
  corral.fake?.setResponses([
    // (1) The first request is held, so a join sent now waits for the next one.
    async (context) => {
      requests.push(JSON.stringify(context.messages));
      first.reach();
      await first.opened;
      return fauxAssistantMessage([plan(0)], { stopReason: 'toolUse' });
    },
    // (2) Held as soon as it is asked for, so the join it carries is read with nothing growing;
    // released, its words stream and thinking after them keeps the response open.
    async (context) => {
      requests.push(JSON.stringify(context.messages));
      second.reach();
      await second.opened;
      return fauxAssistantMessage([{ type: 'text', text: reply }, thinking(30), plan(1)], {
        stopReason: 'toolUse',
      });
    },
    // (3) After the interrupt: the answer, then thinking, then the role ends with a join unread.
    async (context) => {
      requests.push(JSON.stringify(context.messages));
      third.reach();
      await third.opened;
      return fauxAssistantMessage([
        { type: 'text', text: 'Looked at session.ts as asked.' },
        thinking(15),
      ]);
    },
    // (4) The carried request's run.
    (context) => {
      requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('Checked the cache.');
    },
  ]);

  await page.setViewportSize({ width: 1280, height: 800 });
  await corral.open('/projects/default');
  await newConversation(page);
  const box = requestBox(page);
  await expect(box).toBeFocused();
  const items = page.locator('[data-chat-item]');
  const message = (text: string) => items.filter({ hasText: text });
  const status = (text: string) => message(text).getByTestId('entry-status').first();

  // The request starts a run, whose first response is held.
  await page.keyboard.type('Find why login is slow');
  await page.keyboard.press('Enter');
  await first.reached;
  await waitForStill(page);
  await expect(box).toBeFocused();
  await checkLabels(page, SCENE, 'run held');

  // Join: the send key. The message waits to join at the next model request.
  await page.keyboard.type('Run the tests too');
  await waitForStill(page);
  await measure(page, SCENE, 'join-send', async () => {
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('');
    await expect(status('Run the tests too')).toHaveText(starts(msg('Sessions.meta.waiting')));
  });
  await expect.poll(() => directive('Run the tests too')?.status).toBe('queued');

  // Released: the next request reads it, and its line says so.
  await measure(page, SCENE, 'join-read', async () => {
    first.open();
    await second.reached;
    await expect.poll(() => directive('Run the tests too')?.status).toBe('delivered');
    await expect(status('Run the tests too')).toHaveText(starts(msg('Sessions.meta.read')));
  });
  expect(requests[1]).toContain('Run the tests too');

  // The reply streams; once its words are all on screen, the interrupt key cuts it.
  second.open();
  await expect(page.getByTestId('live-text')).toContainText(reply, { timeout: 30_000 });
  await waitForStill(page);
  await page.keyboard.type('Look at session.ts instead');
  await waitForStill(page);
  await measure(page, SCENE, 'interrupt', async () => {
    await page.keyboard.press('Control+Enter');
    await third.reached;
    await expect.poll(() => directive('Look at session.ts instead')?.status).toBe('delivered');
    await expect(status('Look at session.ts instead')).toHaveText(
      starts(msg('Sessions.meta.interrupted')),
    );
  });
  expect(requests[2]).toContain('Look at session.ts instead');
  expect(
    Object.values(projection(0)?.modelCalls ?? {}).some((call) => call.interrupted === true),
  ).toBe(true);
  // The cut words stay.
  const cut = page.getByTestId('stopped-text');
  await expect(cut).toContainText(reply);
  const cutAt = await cutPlace(page);

  // A join the role ends before reading: the answer's words are all on screen first.
  third.open();
  await expect(page.getByTestId('live-text')).toContainText('Looked at session.ts as asked.', {
    timeout: 30_000,
  });
  await waitForStill(page);
  await page.keyboard.type('Also check the cache');
  await waitForStill(page);
  await measure(page, SCENE, 'join-send-late', async () => {
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('');
    await expect(status('Also check the cache')).toHaveText(starts(msg('Sessions.meta.waiting')));
  });

  // The role ends first; the message starts a new request, drawn once, and its run ends.
  await measure(page, SCENE, 'carried-start', async () => {
    await expect(status('Also check the cache')).toHaveText(
      starts(msg('Sessions.meta.carriedStarted')),
      {
        timeout: 60_000,
      },
    );
    await expect.poll(() => runs().length, { timeout: 30_000 }).toBe(2);
    await expect.poll(() => projection(1)?.status, { timeout: 30_000 }).toBe('succeeded');
    await expect(page.getByTestId('live-text')).toHaveCount(0);
  });
  expect(projection(0)?.status).toBe('succeeded');
  expect(requests[3]).toContain('Also check the cache');
  await expect(page.getByText('Also check the cache', { exact: true })).toHaveCount(1);

  // The cut words are still where they stood, at the same height, marked as cut.
  await expect(cut).toContainText(reply);
  await expect(cut.getByRole('note')).toHaveText(msg('MessageBody.interrupted'));
  const cutAfter = await cutPlace(page);
  // Its height is recorded: the note that marks it as cut comes under its words.
  note(SCENE, 'cut reply', { afterInterrupt: cutAt, afterEnd: cutAfter });
  expect
    .soft(
      Math.abs((cutAfter?.top ?? Number.NaN) - (cutAt?.top ?? Number.NaN)),
      `${SCENE}: the cut reply's place`,
    )
    .toBeLessThanOrEqual(1);

  await checkLabels(page, SCENE, 'end');
  await checkChrome(page, SCENE, 'end');
  await shot(page, SCENE, 'end');
  nothingWaiting(corral.server.coordinator, SCENE);
  expect(corral.errors).toEqual([]);
});
