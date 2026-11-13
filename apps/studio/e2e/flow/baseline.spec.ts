import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import { defaultReply } from '@corral/testkit';
import type { Page } from '@playwright/test';
import approvalDefinition from '../../../../examples/research-team.corral.json' with {
  type: 'json',
};
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox, runGoing } from '../workbench.ts';
import {
  type ChromeMeasure,
  createProbe,
  measureChrome,
  type ShiftResult,
  waitForStill,
} from './probe.ts';

// Baseline of today's screen (docs/plans/unified-flow.md §9, V1): how far existing items move
// in four transitions. It records; it sets no pass mark on the shifts.
// Every interval is bounded by held responses: the screen is still when it starts, the action
// that causes the transition (a click or a release) happens inside it, and it ends once the
// screen is still again. Nothing changes between one interval's end and the next one's start,
// and screenshots are taken only while the screen is still.

const OUT = join(import.meta.dirname, '..', '..', 'test-results', 'flow');
const SHOTS = join(OUT, 'baseline');
const BASELINE = join(OUT, 'baseline.json');

// Today's DOM: conversation items carry data-chat-item; sidebar session rows are the menu
// sub-items marked with their kind.
const probeOptions = {
  itemSelector: '[data-chat-item]',
  rowSelector: '[data-sidebar-index][data-session-kind]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

type Transition = 'send-to-start' | 'streaming' | 'working-to-approval' | 'run-end';
interface Baseline {
  transitions: Partial<Record<Transition, Omit<ShiftResult, 'name'>>>;
  chrome?: ChromeMeasure;
}

function record(update: (baseline: Baseline) => void) {
  mkdirSync(OUT, { recursive: true });
  const baseline: Baseline = existsSync(BASELINE)
    ? JSON.parse(readFileSync(BASELINE, 'utf8'))
    : { transitions: {} };
  update(baseline);
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
}

function shot(page: Page, transition: Transition, step: 'before' | 'after') {
  const path = join(SHOTS, `${transition}-${step}.png`);
  mkdirSync(dirname(path), { recursive: true });
  return page.screenshot({ path });
}

function expectMeasured(result: ShiftResult) {
  expect(result.samples.frames, `${result.name}: frames`).toBeGreaterThan(0);
  expect(result.samples.tracked.item, `${result.name}: conversation items`).toBeGreaterThan(0);
  // Every transition has a conversation item, a composer and an input box on screen.
  for (const value of [
    result.maxContainerShiftPx,
    result.maxViewportShiftPx,
    result.maxTailGapChangePx,
    result.maxInputBottomChangePx,
  ])
    expect(Number.isFinite(value), `${result.name}: measured`).toBe(true);
}

async function measure(
  page: Page,
  transition: Transition,
  happen: () => Promise<void>,
): Promise<ShiftResult> {
  const probe = createProbe(page, probeOptions);
  await shot(page, transition, 'before');
  await probe.start(transition);
  await happen();
  await waitForStill(page);
  const result = await probe.stop();
  await shot(page, transition, 'after');
  expectMeasured(result);
  const { name: _name, ...shift } = result;
  record((baseline) => {
    baseline.transitions[transition] = shift;
  });
  return result;
}

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

test.describe('conversation', () => {
  test.use({ live: true, codexLogin: true, streamTokensPerSecond: 60 });

  test('send, start, stream and end of a conversation run', async ({ page, corral }) => {
    test.setTimeout(120_000);
    const reply = hold();
    const finish = hold();
    const ending = 'End of the streamed reply.';
    // Runs in the order they were created (listRuns gives the newest first).
    const runs = () => [...corral.server.coordinator.listRuns()].reverse();
    const status = (index: number) => {
      const run = runs()[index];
      return run ? corral.server.coordinator.getSnapshot(run.runId).projection.status : null;
    };
    corral.fake?.setResponses([
      fauxAssistantMessage('A first short answer, so the timeline has items.'),
      // The second run's reply streams and then calls a tool, so the run stays open (held at
      // the next response) until the run-end interval releases it.
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

    await corral.open('/projects/default');
    await newConversation(page);
    await requestBox(page).fill('First request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => status(0), { timeout: 30_000 }).toBe('succeeded');
    await expect(page.getByTestId('chat-result')).toBeVisible();
    // The page itself has seen the run end, so the next request starts a run, not a queue.
    await expect(runGoing(page)).toHaveCount(0);
    // The sidebar row says its run ended through its mark's name, not in words (presence.md).
    await expect(
      page
        .getByTestId('app-sidebar')
        .locator('[data-session-row]')
        .filter({ hasText: 'First request' })
        .getByRole('link')
        .getByRole('img', { name: 'Completed', exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await waitForStill(page);
    const chrome = await measureChrome(page);
    record((baseline) => {
      baseline.chrome = chrome;
    });

    // (1) The request is sent and its run starts; the reply is held back.
    await requestBox(page).fill('Second request');
    await waitForStill(page);
    await measure(page, 'send-to-start', async () => {
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => runs().length).toBe(2);
      await reply.reached;
      await expect(runGoing(page)).toBeVisible();
    });

    // (2) The reply streams in and its text grows, up to the held next response.
    await measure(page, 'streaming', async () => {
      reply.open();
      await finish.reached;
      await expect(page.getByTestId('chat-timeline')).toContainText(ending, { timeout: 30_000 });
    });
    expect(status(1)).toBe('running');

    // (4) The last response is released and the run ends.
    await measure(page, 'run-end', async () => {
      finish.open();
      await expect.poll(() => status(1), { timeout: 30_000 }).toBe('succeeded');
      await expect(page.getByTestId('live-text')).toHaveCount(0);
      await expect(runGoing(page)).toHaveCount(0);
    });
    expect(corral.errors).toEqual([]);
  });
});

// The reviewer's first reply in the last review round is held; releasing it leads straight to
// the approval (the scripted reviewer passes from round 2 on).
const approvalHold = { point: hold(), used: false };

test.describe('approval', () => {
  test.use({
    agentReply: {
      reply: defaultReply,
      beforeReply: async (_turn, input) => {
        if (approvalHold.used || input.nodeId !== 'review' || input.round !== 2) return;
        approvalHold.used = true;
        approvalHold.point.reach();
        await approvalHold.point.opened;
      },
    },
  });

  test('a working run enters a waiting approval', async ({ page, corral }) => {
    test.setTimeout(60_000);
    await corral.open('/');
    const { sessionId } = await page.evaluate(async (definition) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const call = async (path: string, body: unknown) => {
        const response = await fetch(`/api/v1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`setup ${path}: ${response.status}`);
        return response.json();
      };
      const saved = await call('/corrals', { definition });
      const session = (
        await call('/sessions', {
          projectId: 'default',
          title: 'Approval baseline',
          corralId: saved.record.corralId,
        })
      ).session;
      await call('/runs', {
        schemaVersion: '0.1',
        commandId: 'flow-baseline-approval',
        sessionId: session.sessionId,
        corralId: saved.record.corralId,
        definitionRevision: saved.record.definitionRevision,
        mode: 'mock',
      });
      return { sessionId: session.sessionId as string };
    }, approvalDefinition);
    await approvalHold.point.reached;
    await corral.open(`/sessions/${sessionId}`);
    const decide = page
      .locator('[data-testid^="approval-"]')
      .getByRole('button', { name: 'Continue with this version' });
    await expect(page.locator('[data-chat-item]').first()).toBeVisible();
    await waitForStill(page);
    await expect(decide).toHaveCount(0);

    // (3) Working (the review is held), then the approval card arrives.
    await measure(page, 'working-to-approval', async () => {
      approvalHold.point.open();
      await expect(decide).toBeVisible({ timeout: 30_000 });
    });
    expect(corral.errors).toEqual([]);
  });
});
