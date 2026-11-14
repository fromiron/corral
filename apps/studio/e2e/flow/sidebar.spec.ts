import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { newConversation, newConversationFromSidebar, requestBox, runGoing } from '../workbench.ts';
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

// The sidebar scene (docs/guides/testing.md "흐름 장면"; features/presence.md "유예", workbench.md
// "사이드바"): a session whose run goes has a next request queued. The run ends and the server
// starts the queued request at once, well inside the two-second grace: the session's sidebar row
// stays in its group on every frame and does not move. The new run then asks the person a
// question: the row goes to the group that waits on the person at once, without the grace. No
// sidebar row says a state name in words, and nothing else on screen moves.

const SCENE = 'sidebar';
const GRACE_MS = 2_000;

/** Records the row's group on every frame, with the time it changed, until `stop`. */
async function followGroup(page: Page, sessionId: string) {
  await page.evaluate((sessionId) => {
    const seen = { changes: [] as { at: number; group: string | null }[], running: true };
    (window as unknown as { __groups: typeof seen }).__groups = seen;
    const frame = () => {
      const group =
        document
          .querySelector(`[data-session-row="${CSS.escape(sessionId)}"]`)
          ?.getAttribute('data-session-group') ?? null;
      if (seen.changes.at(-1)?.group !== group) seen.changes.push({ at: Date.now(), group });
      if (seen.running) requestAnimationFrame(frame);
    };
    frame();
  }, sessionId);
  return {
    read: () =>
      page.evaluate(
        () =>
          (window as unknown as { __groups: { changes: { at: number; group: string | null }[] } })
            .__groups.changes,
      ),
    stop: () =>
      page.evaluate(() => {
        (window as unknown as { __groups: { running: boolean } }).__groups.running = false;
      }),
  };
}

test.use({ live: true, codexLogin: true });

test('sidebar: a queued request starting within the grace keeps its row; a question moves it at once', async ({
  page,
  corral,
}) => {
  test.setTimeout(180_000);
  const first = hold();
  const second = hold();
  let questionAt = 0;
  corral.fake?.setResponses([
    fauxAssistantMessage('An older session, already answered.'),
    // The watched session's run, held so its next request is queued while it goes.
    async () => {
      first.reach();
      await first.opened;
      return fauxAssistantMessage('First run done.');
    },
    // The queued request's run: held, then a question to the person.
    async () => {
      second.reach();
      await second.opened;
      return fauxAssistantMessage(
        [
          fauxToolCall('ask_user', {
            key: 'format',
            questions: [{ id: 'format', kind: 'text', prompt: 'Which format should I use?' }],
          }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('Done, as a table.'),
  ]);
  const runs = () => [...corral.server.coordinator.listRuns()].reverse();
  const status = (index: number) => {
    const run = runs()[index];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection.status : null;
  };

  await page.setViewportSize({ width: 1280, height: 800 });
  await corral.open('/projects/default');
  // An older session first, so the sidebar lists more than the watched one.
  await newConversation(page);
  await requestBox(page).fill('An older request');
  await requestBox(page).press('Enter');
  await expect.poll(() => status(0), { timeout: 30_000 }).toBe('succeeded');
  const older = page.url();
  await newConversationFromSidebar(page);
  await expect(page).not.toHaveURL(older);
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  const box = requestBox(page);
  await box.fill('Find why login is slow');
  await box.press('Enter');
  await first.reached;
  await expect(runGoing(page)).toBeVisible();
  // The next request waits in the queue while the run goes (Alt+Enter: next request).
  await box.fill('Then write the summary');
  await box.press('Alt+Enter');
  await expect(
    page.getByRole('region', { name: msg('Sessions.queueHeading'), exact: true }),
  ).toContainText('Then write the summary');
  const row = page.locator(`[data-session-row="${sessionId}"]`);
  await expect(row).toHaveAttribute('data-session-group', 'running');
  await expect(page.locator('[data-session-row]')).toHaveCount(2);
  await waitForStill(page);
  await checkLabels(page, SCENE, 'run going, request queued');

  // The run ends; the server starts the queued request inside the grace.
  const groups = await followGroup(page, sessionId);
  await measure(page, SCENE, 'run-end-next-start', async () => {
    first.open();
    await second.reached;
    await expect.poll(() => status(2)).toBe('running');
  });
  const ended = corral.server.coordinator.getSnapshot(runs()[1]?.runId ?? '').projection;
  const next = corral.server.coordinator.getSnapshot(runs()[2]?.runId ?? '').projection;
  expect(ended.status).toBe('succeeded');
  const startedAfterMs = Date.parse(next.startedAt ?? '') - Date.parse(ended.endedAt ?? '');
  const throughEnd = await groups.read();
  note(SCENE, 'run end to next start', { startedAfterMs, groups: throughEnd });
  expect
    .soft(startedAfterMs, `${SCENE}: the next run started within the grace`)
    .toBeLessThan(GRACE_MS);
  expect
    .soft(
      throughEnd.map((change) => change.group),
      `${SCENE}: the row's group on every frame`,
    )
    .toEqual(['running']);
  await checkLabels(page, SCENE, 'next run going');

  // The new run asks the person: the row moves to the waiting group at once.
  await measure(page, SCENE, 'question-moves-row', async () => {
    second.open();
    await expect.poll(() => status(2), { timeout: 30_000 }).toBe('awaiting_user');
    questionAt = Date.now();
    await expect(row).toHaveAttribute('data-session-group', 'attention', { timeout: 10_000 });
  });
  const changes = await groups.read();
  await groups.stop();
  const moved = changes.find((change) => change.group === 'attention');
  // The server reached the state at most a poll before `questionAt` saw it.
  const latencyMs = moved ? moved.at - questionAt : null;
  note(SCENE, 'question to attention', { latencyMs, groups: changes });
  expect
    .soft(latencyMs ?? Number.POSITIVE_INFINITY, `${SCENE}: the row moved without the grace`)
    .toBeLessThan(GRACE_MS);
  await checkLabels(page, SCENE, 'waiting on the person');
  await shot(page, SCENE, 'waiting-on-the-person');

  // Answered, the run ends; nothing waits.
  const form = page
    .locator('[data-pending-tray]')
    .getByRole('form', { name: msg('Harness.userQuestions') });
  await expect(form).toBeVisible();
  await form.getByRole('textbox', { name: msg('Harness.yourAnswer') }).fill('A table');
  await form.getByRole('button', { name: msg('Harness.sendAnswer'), exact: true }).click();
  await expect.poll(() => status(2), { timeout: 30_000 }).toBe('succeeded');
  await expect(runGoing(page)).toHaveCount(0);
  await checkLabels(page, SCENE, 'end');
  await checkChrome(page, SCENE, 'end');
  await shot(page, SCENE, 'end');
  nothingWaiting(corral.server.coordinator, SCENE);
  expect(corral.errors).toEqual([]);
});
