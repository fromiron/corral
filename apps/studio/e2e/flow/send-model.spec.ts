import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { createProbe, type ShiftResult, waitForStill } from './probe.ts';

// Scene ③ (docs/plans/unified-flow.md §4.4, features/composer-flow.md "전송"): while a run goes,
// the keyboard alone joins, interrupts and queues. A join is read at the model's next request,
// an interrupt cuts the streaming response and is read by the request after it, and a next
// request waits in the queue until the server starts it when the run ends. Sending, and the
// run ending and the next one starting, move nothing already on screen.

const probeOptions = {
  itemSelector: '[data-chat-item]',
  rowSelector: '[data-sidebar-index][data-session-kind]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

/** A point a held response waits at: `reached` when the response is asked for, then `open`. */
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

/** The ids of the conversation items, in order. */
const itemIds = (page: Page) =>
  page.$$eval('[data-chat-item]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-chat-item')),
  );

function expectStill(result: ShiftResult, except: (string | null)[] = []) {
  expect(result.samples.frames, `${result.name}: frames`).toBeGreaterThan(0);
  expect(result.maxInputBottomChangePx ?? 0, `${result.name}: input`).toBeLessThanOrEqual(1);
  const moved = result.items.filter(
    (item) =>
      item.kind === 'item' &&
      !except.some((id) => id && item.id.includes(id)) &&
      Math.max(item.maxContainerShiftYPx, item.maxContainerShiftXPx) > 1,
  );
  expect(moved, `${result.name}: moved items`).toEqual([]);
}

test.describe('sending while a run goes', () => {
  test.use({ live: true, codexLogin: true, streamTokensPerSecond: 30 });

  test('join, interrupt and next request by keyboard', async ({ page, corral }) => {
    test.setTimeout(180_000);
    const first = hold();
    const streaming = hold();
    const third = hold();
    // What each model request carried, in order.
    const requests: string[] = [];
    const runs = () => [...corral.server.coordinator.listRuns()].reverse();
    const projection = (index: number) => {
      const run = runs()[index];
      return run ? corral.server.coordinator.getSnapshot(run.runId).projection : null;
    };
    const plan = (revision: number) => {
      const current = projection(0);
      return fauxToolCall('update_plan', {
        scope: 'execution',
        expectedRevision: revision,
        criteriaVersionId: current?.currentCriteriaVersionId ?? null,
        items: [{ id: 'look', title: 'Look at the session store', status: 'in_progress' }],
      });
    };
    corral.fake?.setResponses([
      // (1) The first request is held, so a join sent now waits for the next one.
      async (context) => {
        requests.push(JSON.stringify(context.messages));
        first.reach();
        await first.opened;
        return fauxAssistantMessage([plan(0)], { stopReason: 'toolUse' });
      },
      // (2) A long reply streams slowly; the interrupt cuts it.
      (context) => {
        requests.push(JSON.stringify(context.messages));
        streaming.reach();
        return fauxAssistantMessage(
          [
            {
              type: 'text',
              text: `${'Reading the store one file at a time before changing anything. '.repeat(20)}`,
            },
            plan(1),
          ],
          { stopReason: 'toolUse' },
        );
      },
      // (3) After the interrupt; held, so a next request is queued while the run goes.
      async (context) => {
        requests.push(JSON.stringify(context.messages));
        third.reach();
        await third.opened;
        return fauxAssistantMessage('Looked at session.ts as asked.');
      },
      // (4) The queued request, started by the server once the first run ended.
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('Summary written.');
      },
    ]);

    await corral.open('/projects/default');
    await newConversation(page);
    const box = requestBox(page);
    await box.fill('Find why login is slow');
    await box.press('Enter');
    await first.reached;
    // The tool line names the target and says what the keys send now.
    await expect(page.locator('[data-slot="composer-target"]')).toBeVisible();
    await expect(page.locator('[data-slot="composer-keys"]')).toContainText('Join');
    await expect(page.locator('[data-slot="composer-keys"]')).toContainText('Interrupt');
    await waitForStill(page);

    // Join: the send key. Accepted now, read at the model's next request.
    await box.fill('Run the tests too');
    await waitForStill(page);
    let probe = createProbe(page, probeOptions);
    await probe.start('join-send');
    await box.press('Enter');
    await expect(box).toHaveValue('');
    await expect(page.locator('[data-chat-item]').last()).toContainText('Run the tests too');
    await waitForStill(page);
    expectStill(await probe.stop());
    const joined = () =>
      Object.values(projection(0)?.directives ?? {}).find(
        (item) => item.text === 'Run the tests too',
      );
    await expect.poll(() => joined()?.status).toBe('queued');
    first.open();
    await streaming.reached;
    expect(requests[1]).toContain('Run the tests too');
    await expect.poll(() => joined()?.status).toBe('delivered');

    // Interrupt: the interrupt key cuts the streaming reply; the next request carries it.
    await expect(page.getByTestId('live-text')).toBeVisible({ timeout: 30_000 });
    await box.fill('Look at session.ts instead');
    const before = await itemIds(page);
    probe = createProbe(page, probeOptions);
    await probe.start('interrupt-send');
    await box.press('Control+Enter');
    await third.reached;
    await waitForStill(page);
    // The reply streams inside the first item (the run), and the conversation lists the earlier
    // instruction under it, so both move with the text that streams until the cut lands. That
    // growth is the stream's, not the send's; the composer and the new item stay still.
    expectStill(await probe.stop(), before);
    expect(requests[2]).toContain('Look at session.ts instead');
    expect(
      Object.values(projection(0)?.modelCalls ?? {}).some((call) => call.interrupted === true),
    ).toBe(true);
    expect(projection(0)?.status).toBe('running');

    // Next request: Alt+Enter queues it; the server starts it once the run ends.
    await box.fill('Then write the summary');
    await waitForStill(page);
    probe = createProbe(page, probeOptions);
    await probe.start('queue-send');
    await box.press('Alt+Enter');
    await expect(page.getByRole('region', { name: 'Queued next tasks' })).toContainText(
      'Then write the summary',
    );
    await waitForStill(page);
    expectStill(await probe.stop());
    expect(runs()).toHaveLength(1);

    // The run ends and the server starts the queued request: the composer stays still. The ended
    // run folds its process into one line, which lifts the instructions listed under it; that
    // fold belongs to the conversation's run rendering, not to sending.
    const settling = (await itemIds(page)).slice(1);
    probe = createProbe(page, probeOptions);
    await probe.start('run-end-next-start');
    third.open();
    await expect.poll(() => runs().length, { timeout: 30_000 }).toBe(2);
    await expect.poll(() => projection(1)?.status, { timeout: 30_000 }).toBe('succeeded');
    await expect(page.getByRole('region', { name: 'Queued next tasks' })).toHaveCount(0);
    await waitForStill(page);
    expectStill(await probe.stop(), settling);
    expect(projection(0)?.status).toBe('succeeded');
    expect(requests[3]).toContain('Then write the summary');
    expect(corral.errors).toEqual([]);
  });
});
