import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fauxAssistantMessage } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import approvalDefinition from '../../../../examples/research-team.corral.json' with {
  type: 'json',
};
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { type ChromeMeasure, createProbe, measureChrome, type ShiftResult } from './probe.ts';

// Baseline of today's screen (docs/plans/unified-flow.md §9, V1): how far existing items move
// in four transitions. It records; it sets no pass mark on the shifts.

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
  expect(result.items.length, `${result.name}: items measured`).toBeGreaterThan(0);
  expect(result.frames, `${result.name}: frames`).toBeGreaterThan(0);
  for (const value of [
    result.maxContainerShiftPx,
    result.maxViewportShiftPx,
    // Every transition has a conversation item, a composer and an input box on screen.
    result.maxTailGapChangePx,
    result.maxInputBottomChangePx,
    ...result.items.flatMap((item) => [item.maxContainerShiftPx, item.maxViewportShiftPx]),
  ])
    expect(Number.isFinite(value), `${result.name}: finite shift`).toBe(true);
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
  const result = await probe.stop();
  await shot(page, transition, 'after');
  expectMeasured(result);
  const { name: _name, ...shift } = result;
  record((baseline) => {
    baseline.transitions[transition] = shift;
  });
  return result;
}

/** Lets late layout (fonts, transitions) settle inside the interval. */
const settle = (page: Page) => page.waitForTimeout(600);

test.describe('conversation', () => {
  test.use({ live: true, codexLogin: true, streamTokensPerSecond: 60 });

  test('send, start, stream and end of a conversation run', async ({ page, corral }) => {
    test.setTimeout(120_000);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ending = 'End of the streamed reply.';
    corral.fake?.setResponses([
      fauxAssistantMessage('A first short answer, so the timeline has items.'),
      async () => {
        await held;
        return fauxAssistantMessage(
          `${'The reply keeps growing while it streams in. '.repeat(12)}${ending}`,
        );
      },
    ]);
    const runs = () => corral.server.coordinator.listRuns();
    const status = (index: number) => {
      const run = runs()[index];
      return run ? corral.server.coordinator.getSnapshot(run.runId).projection.status : null;
    };

    await corral.open('/projects/default');
    await newConversation(page);
    await requestBox(page).fill('First request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => status(0), { timeout: 30_000 }).toBe('succeeded');
    await expect(page.getByTestId('chat-result')).toBeVisible();
    // The page itself has seen the run end, so the next request starts a run, not a queue.
    await expect(page.getByRole('link', { name: 'Succeeded Last run' })).toBeVisible();
    await settle(page);
    const chrome = await measureChrome(page);
    record((baseline) => {
      baseline.chrome = chrome;
    });

    // (1) The request is sent and its run starts (the reply is held back).
    await requestBox(page).fill('Second request');
    await measure(page, 'send-to-start', async () => {
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => runs().length).toBe(2);
      await expect(page.getByRole('region', { name: 'Active run controls' })).toBeVisible();
      await settle(page);
    });

    // (2) The reply streams in and its text grows.
    release();
    const live = page.getByTestId('live-text');
    await expect(live).toBeVisible({ timeout: 30_000 });
    await measure(page, 'streaming', async () => {
      // The last words reach the timeline (the live text may already have become the result).
      await expect(page.getByTestId('chat-timeline')).toContainText(ending, { timeout: 60_000 });
    });

    // (4) The run ends and the streamed text becomes the result.
    await measure(page, 'run-end', async () => {
      await expect.poll(() => status(1), { timeout: 30_000 }).toBe('succeeded');
      await expect(live).toHaveCount(0);
      await settle(page);
    });
    expect(corral.errors).toEqual([]);
  });
});

test.describe('approval', () => {
  // Scripted agents answer slowly enough that the run is seen working first.
  test.use({ replyDelayMs: 1500 });

  test('a working run enters a waiting approval', async ({ page, corral }) => {
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
    await corral.open(`/sessions/${sessionId}`);
    const decide = page
      .locator('[data-testid^="approval-"]')
      .getByRole('button', { name: 'Continue with this version' });
    await expect(page.locator('[data-chat-item]').first()).toBeVisible();
    await expect(decide).toHaveCount(0);

    // (3) Working, then the approval card arrives.
    await measure(page, 'working-to-approval', async () => {
      await expect(decide).toBeVisible({ timeout: 30_000 });
      await settle(page);
    });
    expect(corral.errors).toEqual([]);
  });
});
