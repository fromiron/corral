import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { templateForWorkspace } from '../../src/demo/templates.ts';
import { expect, type Harness, test } from '../server/harness.ts';
import {
  activityBar,
  activityLine,
  closeSettings,
  earlierRequests,
  newConversation,
  openActivity,
  openFolderSettings,
  panelTab,
  requestBox,
  runGoing,
} from '../workbench.ts';
import {
  countVisibleLabels,
  createProbe,
  duplicateLabels,
  measureChrome,
  type ShiftResult,
  waitForStill,
} from './probe.ts';

// The composer's activity bar (docs/specs/features/composer-flow.md "활동 바"), in the scenes of
// docs/plans/unified-flow.md §9: (①) one height with and without a run, in both themes, the
// fixed areas within their bound and nothing on screen moving as a run starts and ends; (②) a
// team's roles, none named on the bar while its row is on screen, and the join target chosen
// from the bar; (④) an approval scrolled off screen, said and decided once, from the bar, never
// by Enter. Every scene checks that no state name is on screen twice. Responses are scripted.

const OUT = join(import.meta.dirname, '..', '..', 'test-results', 'flow');
const RESULTS = join(OUT, 'activity-bar.json');
const results: Record<string, unknown> = {};
const record = (name: string, value: unknown) => {
  results[name] = value;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
};

const probeOptions = {
  itemSelector: '[data-chat-item]',
  containerSelector: '[data-testid="chat-timeline"], [data-slot="scroll-area-viewport"]',
};

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

async function barHeights(page: Page) {
  const heights: Record<string, number> = {};
  for (const scheme of ['light', 'dark'] as const) {
    // The app follows the system theme (its default) with the dark class on the root.
    await page.emulateMedia({ colorScheme: scheme });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(scheme === 'dark');
    await waitForStill(page, { stillMs: 600 });
    heights[scheme] = (await activityLine(page).boundingBox())?.height ?? 0;
  }
  await page.emulateMedia({ colorScheme: 'light' });
  return heights;
}

async function noDuplicates(page: Page, where: string) {
  expect.soft(await duplicateLabels(page), `${where}: a state name on screen twice`).toEqual({});
}

/** The largest shift of the conversation items alone. */
function itemShift(result: ShiftResult) {
  const values = result.items
    .filter((item) => item.kind === 'item')
    .flatMap((item) => [item.maxContainerShiftYPx, item.maxContainerShiftXPx]);
  return values.length ? Math.max(...values) : null;
}

async function steady(page: Page, name: string, happen: () => Promise<void>) {
  const probe = createProbe(page, probeOptions);
  await probe.start(name);
  await happen();
  await waitForStill(page);
  const result = await probe.stop();
  const shift = itemShift(result);
  record(name, { shift, input: result.maxInputBottomChangePx, tail: result.maxTailGapChangePx });
  expect(result.samples.tracked.item, `${name}: conversation items`).toBeGreaterThan(0);
  expect.soft(shift, `${name}: existing items move`).toBeLessThanOrEqual(1);
  expect.soft(result.maxInputBottomChangePx, `${name}: input bottom`).toBe(0);
}

test.use({ live: true, codexLogin: true });

test('① the bar keeps one height with and without a run, in both themes, and moves nothing', async ({
  page,
  corral,
}) => {
  test.setTimeout(150_000);
  const reply = hold();
  corral.fake?.setResponses([
    fauxAssistantMessage('A first short answer.'),
    async () => {
      reply.reach();
      await reply.opened;
      return fauxAssistantMessage('Second answer.');
    },
  ]);
  await corral.open('/projects/default');
  await newConversation(page);
  await expect(activityBar(page)).toHaveAttribute('data-line', 'none');
  const empty = await barHeights(page);

  await requestBox(page).fill('First request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('chat-result')).toBeVisible({ timeout: 30_000 });
  await expect(runGoing(page)).toHaveCount(0);
  await waitForStill(page);
  const idle = await barHeights(page);
  await noDuplicates(page, 'idle');
  // The fixed areas: the idle composer, and the top bar with it.
  const chrome = await measureChrome(page);
  record('chrome', chrome);
  expect.soft(chrome.composerHeightPx ?? 999, 'idle composer').toBeLessThanOrEqual(148);
  expect
    .soft((chrome.composerHeightPx ?? 999) + (chrome.topBarHeightPx ?? 999), 'fixed areas')
    .toBeLessThanOrEqual(200);

  await requestBox(page).fill('Second request');
  await waitForStill(page);
  await steady(page, 'send-to-start', async () => {
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await reply.reached;
    await expect(runGoing(page)).toBeVisible();
  });
  // Nothing written while the run goes: Stop is in Send's place, by that name, with its square
  // drawn inside it in the button's own contrasting colour.
  const stop = page
    .getByRole('button', { name: 'Stop', exact: true })
    .and(page.getByTestId('composer-stop'));
  await expect(stop).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  const glyph = await stop.evaluate((button) => {
    const mark = [...button.querySelectorAll<HTMLElement>('span')].find(
      (span) => !span.children.length,
    );
    const box = mark?.getBoundingClientRect();
    return {
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      mark: mark ? getComputedStyle(mark).backgroundColor : '',
      button: getComputedStyle(button).backgroundColor,
    };
  });
  expect(glyph.width).toBeGreaterThanOrEqual(10);
  expect(glyph.height).toBeGreaterThanOrEqual(10);
  expect(glyph.mark).not.toBe(glyph.button);
  const running = await barHeights(page);
  await noDuplicates(page, 'running');
  // The top bar says nothing of the run.
  await expect(page.getByRole('banner')).not.toContainText(/Working|Running/);

  await steady(page, 'run-end', async () => {
    reply.open();
    await expect(runGoing(page)).toHaveCount(0, { timeout: 30_000 });
  });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  const ended = await barHeights(page);
  await noDuplicates(page, 'ended');
  record('heights', { empty, idle, running, ended });
  for (const [name, heights] of Object.entries({ idle, running, ended }))
    expect.soft(heights, `${name}: bar height`).toEqual(empty);
  expect(empty.light).toBeGreaterThan(0);
  expect(corral.errors).toEqual([]);
});

/** The lead of a team session hands two tasks to its team and waits; the tasks hold. */
function teamResponses(children: Promise<void>) {
  const step = async (context: { messages: unknown[] }) => {
    const all = JSON.stringify(context.messages);
    const messages = context.messages as { role: string; content?: unknown }[];
    const results = messages.filter((message) => message.role === 'toolResult');
    const lead = all.includes('You lead a team');
    // The host's own calls (the session title) are answered at once.
    if (!lead && !all.includes('Read the session store') && !all.includes('Draft the fix'))
      return fauxAssistantMessage('Fix the slow login');
    if (lead) {
      if (!results.length)
        return fauxAssistantMessage(
          [
            fauxToolCall('spawn_subagents', {
              tasks: [
                { targetNodeId: 'team_researcher', brief: 'Read the session store.' },
                { targetNodeId: 'team_writer', brief: 'Draft the fix.' },
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        );
      const content = (results.at(-1) as { content?: { type: string; text?: string }[] }).content;
      const text = content?.find((part) => part.type === 'text')?.text ?? '{}';
      let taskIds: string[] = [];
      try {
        taskIds = (JSON.parse(text) as { taskIds?: string[] }).taskIds ?? [];
      } catch {
        taskIds = [];
      }
      if (results.length === 1)
        return fauxAssistantMessage([fauxToolCall('await_tasks', { taskIds })], {
          stopReason: 'toolUse',
        });
      return fauxAssistantMessage('The team is done.');
    }
    await children;
    return fauxAssistantMessage('Child done.');
  };
  return Array.from({ length: 12 }, () => step);
}

async function teamSession(page: Page, corral: Harness) {
  const definition = structuredClone(templateForWorkspace('research-team', 'activity').definition);
  await corral.open('/');
  const sessionId = await page.evaluate(
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
        title: 'Fix the slow login',
        corralId: record.corralId,
      });
      return session.sessionId as string;
    },
    { definition },
  );
  await corral.open(`/sessions/${sessionId}`);
  return sessionId;
}

test('② a team: the bar names no role whose row is on screen, and joins from its panel', async ({
  page,
  corral,
}) => {
  test.setTimeout(150_000);
  const children = hold();
  corral.fake?.setResponses(teamResponses(children.opened) as never);
  try {
    await teamSession(page, corral);
    await requestBox(page).fill('Find why login is slow and fix it.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(runGoing(page)).toBeVisible({ timeout: 30_000 });
    const run = () => corral.server.coordinator.listRuns()[0];
    await expect
      .poll(
        () => {
          const current = run();
          return current
            ? Object.keys(
                corral.server.coordinator.getSnapshot(current.runId).projection.executions,
              ).length
            : 0;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(3);
    await waitForStill(page);
    await noDuplicates(page, 'team');
    const visible = Object.keys((await countVisibleLabels(page)).labels);
    const closed = (await activityLine(page).innerText()).trim();

    // The panel lists every role, by name.
    await openActivity(page);
    const rows = activityBar(page).locator('[data-activity-role]');
    await expect(rows).toHaveCount(3);
    const roles: { id: string; name: string }[] = [];
    for (const row of await rows.all())
      roles.push({
        id: (await row.getAttribute('data-activity-role')) ?? '',
        name: (await row.locator(':scope > span').nth(1).innerText()).trim(),
      });
    const lead = run()
      ? corral.server.coordinator.getSnapshot(run()?.runId ?? '').projection.executionOrder[0]
      : undefined;
    record('team', { closed, visible, roles, lead });
    // A role whose state is on screen (its own row, or the run row for the lead) is not named.
    for (const role of roles) {
      const seen =
        visible.includes(`execution:${role.id}`) ||
        (role.id === lead && visible.includes(`run:${run()?.runId}`));
      if (seen) expect.soft(closed, `${role.name} is on screen`).not.toContain(`${role.name}:`);
    }
    await noDuplicates(page, 'team panel');

    // Join another role from its row: the tool line's target follows.
    const other = roles.find((role) => role.id !== lead);
    if (!other) throw new Error('A second role is missing');
    await activityBar(page)
      .getByRole('button', { name: `Join ${other.name}`, exact: true })
      .click();
    await expect(page.locator('[data-slot="composer-target"]').first()).toContainText(other.name);
    await expect(activityBar(page).locator(`[data-activity-role="${other.id}"]`)).toContainText(
      'Join target',
    );
    await expect(requestBox(page)).toBeFocused();
    expect(corral.errors).toEqual([]);
  } finally {
    children.open();
  }
});

test('④ an approval scrolled off screen is said and decided once, from the bar, never by Enter', async ({
  page,
  corral,
}) => {
  test.setTimeout(150_000);
  corral.fake?.setResponses([
    fauxAssistantMessage([fauxToolCall('run_command', { command: 'echo tray-ok' })], {
      stopReason: 'toolUse',
    }),
    // The session's title and the run's last words, in whichever order they are asked for.
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage('Done.'),
  ]);
  const original = mkdtempSync(join(tmpdir(), 'corral-activity-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('init', '-q');
  writeFileSync(join(original, 'README.md'), '# Activity\n');
  git('add', '.');
  git('commit', '-q', '-m', 'source');
  try {
    await corral.open('/');
    const folder = await openFolderSettings(page);
    await folder.getByLabel('Folder path on this computer').fill(original);
    await folder.getByRole('button', { name: 'Link folder' }).click();
    await folder.getByRole('switch', { name: /Trust this repository/ }).click();
    await closeSettings(page);
    await newConversation(page);
    const sessionId = new URL(page.url()).pathname.split('/')[2] as string;
    await panelTab(page, 'Files');
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    await page
      .getByRole('region', { name: 'Working copy' })
      .getByRole('button', { name: /Make a working copy from/ })
      .click();
    await expect(page.getByRole('link', { name: 'Review changes', exact: true })).toBeVisible();
    await panelTab(page, 'Conversation');
    await earlierRequests(page, sessionId, 20);
    await page.reload();
    await requestBox(page).fill('Check the folder.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const tray = page.locator('[data-pending-tray]');
    const card = tray.locator('[data-testid^="approval-"]');
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await waitForStill(page);
    const bar = activityBar(page);
    // In view, the card alone says it.
    await expect(bar).not.toHaveAttribute('data-line', 'waiting');
    await expect(bar.getByRole('button', { name: /^Allow once/ })).toHaveCount(0);
    await noDuplicates(page, 'card in view');

    const timeline = page.getByTestId('chat-timeline');
    await timeline.hover({ position: { x: 16, y: 200 } });
    for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, -500);
    await waitForStill(page);
    await expect(tray).not.toBeInViewport();
    await expect(bar).toHaveAttribute('data-line', 'waiting');
    await expect(activityLine(page)).toContainText('Run');
    // Once on screen: the bar's two buttons, the card's out of view.
    const approve = activityLine(page).getByRole('button', { name: /^Allow once/ });
    await expect(approve).toBeInViewport();
    await expect(activityLine(page).getByRole('button', { name: /^Deny/ })).toBeInViewport();
    await expect(card.getByRole('button', { name: /^Allow once/ })).not.toBeInViewport();
    await noDuplicates(page, 'card off screen');
    const pending = () => {
      const run = corral.server.coordinator.listRuns()[0];
      return run
        ? Object.values(
            corral.server.coordinator.getSnapshot(run.runId).projection.approvals,
          ).filter((approval) => approval.status === 'pending').length
        : -1;
    };
    // Enter and Escape decide nothing: on the toggle they open and close the panel.
    const toggle = bar.locator('[data-activity-toggle]');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    expect(pending()).toBe(1);
    await approve.click();
    await expect.poll(pending).toBe(0);
    // The run goes on to its end; read from above, the bar says so.
    await expect(bar).toHaveAttribute('data-run', 'succeeded', { timeout: 30_000 });
    await expect(bar).not.toHaveAttribute('data-line', 'waiting');
    await noDuplicates(page, 'after the decision');
    expect(corral.errors).toEqual([]);
  } finally {
    await rm(original, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
