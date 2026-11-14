import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
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
// docs/guides/testing.md "흐름 장면": (①) one height with and without a run, in both themes, the
// fixed areas within their bound and nothing on screen moving as a run starts and ends; (②) a
// team's roles, none named on the bar while its row is on screen, and the join target chosen
// from the bar; (④) an approval scrolled off screen, said and decided once, from the bar, never
// by Enter; (⑤) the press that sent never stops the run Stop then stands for; (⑥) a call decided
// on the line only while the line says it whole, at every width, and the next call in its place
// not decided by the press meant for the last. Every scene checks that no state name is on screen
// twice. Responses are scripted.

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

/** How many times a word is written on screen whole: drawn, in view, not for AT alone. */
function writtenOnScreen(page: Page, word: string) {
  return page.evaluate((word) => {
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (node.textContent?.trim() !== word || !parent) continue;
      if (parent.closest('.sr-only, [inert], [aria-hidden="true"]')) continue;
      if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const box = parent.getBoundingClientRect();
      if (box.width && box.height && box.bottom > 0 && box.top < innerHeight) count += 1;
    }
    return count;
  }, word);
}

/** How many times visible text on screen holds `words`, in any text node. */
function saidOnScreen(page: Page, words: string) {
  return page.evaluate((words) => {
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent ?? '';
      if (!parent || !text.includes(words)) continue;
      if (parent.closest('.sr-only, [inert], [aria-hidden="true"]')) continue;
      if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const box = parent.getBoundingClientRect();
      if (box.width && box.height && box.bottom > 0 && box.top < innerHeight)
        count += text.split(words).length - 1;
    }
    return count;
  }, words);
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
    const sessionId = await teamSession(page, corral);
    // Earlier requests above, so the run's rows can leave the screen.
    await earlierRequests(page, sessionId, 20);
    await page.reload();
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
    // The work log open, its role rows say what each role waits for beside its state; the
    // line does not say it again (presence.md "한 화면에 한 번").
    const head = page.locator('[data-chat-part="head"] button[aria-expanded]').last();
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await waitForStill(page);
    const details: Record<string, number> = {};
    for (const words of Object.values(en.Presence.detail))
      details[words] = await saidOnScreen(page, words);
    record('team-details', { details, closed: (await activityLine(page).innerText()).trim() });
    for (const [words, count] of Object.entries(details))
      expect.soft(count, `"${words}" said on screen`).toBeLessThanOrEqual(1);
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await waitForStill(page);
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

    // The rows scrolled far away, the panel open: what its rows say, the line does not say again.
    const timeline = page.getByTestId('chat-timeline');
    await timeline.hover({ position: { x: 16, y: 120 } });
    for (let step = 0; step < 8; step += 1) await page.mouse.wheel(0, -500);
    await waitForStill(page);
    await expect(
      page
        .getByTestId('chat-timeline')
        .locator(`[data-presence-label="run:${run()?.runId}"]`)
        .first(),
    ).not.toBeInViewport();
    await openActivity(page);
    await waitForStill(page);
    const open = (await countVisibleLabels(page)).labels;
    record('panel-open-away', open);
    for (const [label, { count }] of Object.entries(open))
      expect.soft(count, `${label} on screen ${count} times`).toBe(1);
    await noDuplicates(page, 'panel open, rows away');
    // A working role's spinner says it works: the word is written once, not once a row.
    const working = await writtenOnScreen(page, 'Working');
    record('panel-open-working', { working });
    expect.soft(working, '"Working" written on screen').toBe(1);

    // View brings the role's row back from outside the conversation's window, with the focus,
    // and leaves the run record closed.
    await activityBar(page)
      .getByRole('button', { name: `View ${other.name}`, exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          const row = active?.closest('[data-chat-part^="role:"], [data-chat-item]');
          if (!row?.closest('[data-testid="chat-timeline"]')) return active?.tagName ?? null;
          const box = row.getBoundingClientRect();
          return box.bottom > 0 && box.top < innerHeight ? 'row' : 'row off screen';
        }),
      )
      .toBe('row');
    expect(new URL(page.url()).searchParams.get('panel')).not.toBe('run');
    record('view-from-away', {
      focus: await page.evaluate(
        () =>
          document.activeElement?.closest('[data-chat-part]')?.getAttribute('data-chat-part') ??
          null,
      ),
    });
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
  const session = await commandSession(page, corral);
  try {
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
    // Enter held down on Allow once: one decision, and its repeats press nothing after it, not
    // the toggle the focus goes back to.
    await approve.focus();
    const held: (string | null)[] = [];
    for (let repeat = 0; repeat < 12; repeat += 1) {
      await page.keyboard.down('Enter');
      await page.waitForTimeout(40);
      held.push(await toggle.getAttribute('aria-expanded'));
    }
    await page.keyboard.up('Enter');
    record('enter-held', held);
    expect(held.filter((expanded) => expanded !== 'false')).toEqual([]);
    await expect.poll(pending).toBe(0);
    // The run goes on to its end; read from above, the bar says so.
    await expect(bar).toHaveAttribute('data-run', 'succeeded', { timeout: 30_000 });
    await expect(bar).not.toHaveAttribute('data-line', 'waiting');
    await noDuplicates(page, 'after the decision');
    expect(corral.errors).toEqual([]);
  } finally {
    await session.cleanup();
  }
});

/** The scripted conversation of ⑤: one finished run, then a second one held. */
async function heldRun(page: Page, corral: Harness) {
  const reply = hold();
  corral.fake?.setResponses([
    fauxAssistantMessage('A first short answer.'),
    async () => {
      reply.reach();
      await reply.opened;
      return fauxAssistantMessage('Second answer.');
    },
    fauxAssistantMessage('Third answer.'),
    fauxAssistantMessage('Fourth answer.'),
  ]);
  await corral.open('/projects/default');
  await newConversation(page);
  await requestBox(page).fill('First request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('chat-result')).toBeVisible({ timeout: 30_000 });
  await expect(runGoing(page)).toHaveCount(0);
  await requestBox(page).fill('Second request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await reply.reached;
  await expect(runGoing(page)).toBeVisible();
  await waitForStill(page);
  return reply;
}

test('⑤ the press that sent, and the next on the same place, do not stop the run', async ({
  page,
  corral,
}) => {
  test.setTimeout(150_000);
  const reply = await heldRun(page, corral);
  const statuses = () => corral.server.coordinator.listRuns().map((run) => run.status);
  try {
    const stop = page.getByTestId('composer-stop');
    await expect(stop).toBeVisible();
    // A join sent with a double click: the second click lands where Stop now is.
    await requestBox(page).fill('Keep it short.');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const box = await send.boundingBox();
    if (!box) throw new Error('Send is missing');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.dblclick(x, y);
    await expect(stop).toBeVisible();
    // And once more, a moment later, on the same place.
    await page.waitForTimeout(250);
    await page.mouse.click(x, y);
    const held = { disabled: await stop.isDisabled(), statuses: statuses() };
    await page.waitForTimeout(300);
    record('send-then-stop', { held, after: statuses() });
    expect(held.disabled).toBe(true);
    expect(statuses().filter((status) => /cancel/.test(status))).toEqual([]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Then it is Stop again, pressable.
    await expect(stop).toBeEnabled({ timeout: 2_000 });
    expect(corral.errors).toEqual([]);
  } finally {
    reply.open();
  }
});

/** A conversation whose agent may run commands in a working copy, with history to scroll. */
async function commandSession(page: Page, corral: Harness) {
  const original = mkdtempSync(join(tmpdir(), 'corral-activity-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('init', '-q');
  writeFileSync(join(original, 'README.md'), '# Activity\n');
  git('add', '.');
  git('commit', '-q', '-m', 'source');
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
    .getByRole('region', { name: 'Paddock' })
    .getByRole('button', { name: /Make a Paddock from/ })
    .click();
  await expect(page.getByRole('link', { name: 'Review changes', exact: true })).toBeVisible();
  await panelTab(page, 'Conversation');
  await earlierRequests(page, sessionId, 20);
  await page.reload();
  return {
    sessionId,
    cleanup: () => rm(original, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/** The closed line's words and buttons: where each sits and whether the words are cut. */
function lineParts(page: Page) {
  return page.evaluate(() => {
    const line = document.querySelector('[data-testid="activity-bar"] [data-activity-bar] > div');
    if (!line) return null;
    const right = line.getBoundingClientRect().right;
    const words = line.querySelector<HTMLElement>('[data-activity-text]');
    return {
      state: line.querySelector('[data-presence-label]')?.textContent ?? null,
      text: words?.textContent ?? null,
      cut: words ? words.scrollWidth > words.clientWidth : null,
      decisions: [...line.querySelectorAll('button')]
        .filter((button) => !button.closest('[inert]'))
        .flatMap((button) => {
          const name = button.getAttribute('aria-label') ?? '';
          return / · /.test(name) ? [name] : [];
        }),
      inside: [...line.querySelectorAll('button')]
        .filter((button) => !button.closest('[inert]'))
        .every((button) => button.getBoundingClientRect().right <= right + 1),
    };
  });
}

test('⑥ the line decides a call only while it says it whole; the next call in its place waits', async ({
  page,
  corral,
}) => {
  test.setTimeout(240_000);
  const asked = { second: false, third: false };
  corral.fake?.setResponses([
    fauxAssistantMessage([fauxToolCall('run_command', { command: 'echo tray-ok' })], {
      stopReason: 'toolUse',
    }),
    // The session's title, and the run after each command, in whichever order they are asked.
    ...Array.from({ length: 8 }, () => (context: { messages: { role: string }[] }) => {
      const results = context.messages.filter((message) => message.role === 'toolResult').length;
      if (results === 1 && !asked.second) {
        asked.second = true;
        return fauxAssistantMessage([fauxToolCall('run_command', { command: 'echo second' })], {
          stopReason: 'toolUse',
        });
      }
      if (results === 2 && !asked.third) {
        asked.third = true;
        return fauxAssistantMessage(
          [fauxToolCall('run_command', { command: 'echo one\necho two' })],
          { stopReason: 'toolUse' },
        );
      }
      return fauxAssistantMessage('Done.');
    }),
  ] as never);
  const session = await commandSession(page, corral);
  try {
    await requestBox(page).fill('Check the folder.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const tray = page.locator('[data-pending-tray]');
    await expect(tray.locator('[data-testid^="approval-"]')).toHaveCount(1, { timeout: 30_000 });
    await waitForStill(page);
    const bar = activityBar(page);
    const timeline = page.getByTestId('chat-timeline');
    const scrollUp = async () => {
      await timeline.hover({ position: { x: 16, y: 120 } });
      for (let step = 0; step < 8; step += 1) await page.mouse.wheel(0, -500);
      await waitForStill(page);
    };
    await scrollUp();
    await expect(bar).toHaveAttribute('data-line', 'waiting');
    // At every width the buttons come only with the whole call beside them.
    const widths: Record<number, unknown> = {};
    for (const width of [1280, 600, 390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await waitForStill(page);
      if ((await bar.getAttribute('data-line')) !== 'waiting') await scrollUp();
      const parts = await lineParts(page);
      widths[width] = parts;
      expect(parts?.text).toContain('echo tray-ok');
      if (parts?.decisions.length) {
        expect.soft(parts.cut, `${width}: decided with its words cut`).toBe(false);
        expect.soft(parts.inside, `${width}: a button outside the line`).toBe(true);
      }
      await expect(
        activityLine(page).getByRole('button', { name: 'View', exact: true }),
      ).toBeVisible();
    }
    record('fit', widths);
    // Wide, the whole call fits beside its buttons, named in full.
    const approve = activityLine(page).getByRole('button', {
      name: 'Allow once · Run · echo tray-ok',
      exact: true,
    });
    await expect(approve).toBeVisible();
    const pending = () => {
      const run = corral.server.coordinator.listRuns()[0];
      return run
        ? Object.values(corral.server.coordinator.getSnapshot(run.runId).projection.approvals)
            .filter((approval) => approval.status === 'pending')
            .map((approval) => approval.approvalId)
        : [];
    };
    const spot = await approve.boundingBox();
    if (!spot) throw new Error('Allow once is missing');
    const first = pending();
    const x = spot.x + spot.width / 2;
    const y = spot.y + spot.height / 2;
    // From inside the page, every frame: the frame the next call's Allow once first stands on the
    // same place, that place is pressed, before anything else runs.
    await page.evaluate(
      ({ x, y }) => {
        const w = window as unknown as {
          nextPress: { disabled: boolean; at: number } | null;
          nextFrames: string[];
        };
        w.nextPress = null;
        w.nextFrames = [];
        const tick = () => {
          const bar = document.querySelector('[data-testid="activity-bar"]');
          const frame = `${bar?.getAttribute('data-line')}: ${[
            ...(bar?.querySelectorAll('[data-activity-bar] > div button') ?? []),
          ]
            .filter((button) => !button.closest('[inert]'))
            .map(
              (button) =>
                `${button.getAttribute('aria-label') ?? button.textContent}${(button as HTMLButtonElement).disabled ? ' (off)' : ''}`,
            )
            .join(' | ')}`;
          if (w.nextFrames.at(-1) !== frame) w.nextFrames.push(frame);
          // Found by where it stands, not by hit testing: a held button lets the pointer through.
          const next = [
            ...(bar?.querySelectorAll<HTMLButtonElement>('[data-activity-bar] > div button') ?? []),
          ].find(
            (button) =>
              !button.closest('[inert]') &&
              button.getAttribute('aria-label') === 'Allow once · Run · echo second',
          );
          const box = next?.getBoundingClientRect();
          if (next && box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
            w.nextPress = { disabled: next.disabled, at: performance.now() };
            // Pressed in that frame: a held button takes no press, one that is not decides.
            next.click();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { x, y },
    );
    await page.mouse.click(x, y);
    // The next call comes to the same place; the same place pressed as it comes does not decide it.
    await expect(activityLine(page)).toContainText('echo second', { timeout: 30_000 });
    const next = activityLine(page).getByRole('button', {
      name: 'Allow once · Run · echo second',
      exact: true,
    });
    const pressed = await page
      .waitForFunction(() => (window as unknown as { nextPress: unknown }).nextPress, null, {
        timeout: 10_000,
      })
      .then((handle) => handle.jsonValue() as Promise<{ disabled: boolean; at: number }>);
    await page.waitForTimeout(200);
    const waiting = pending();
    const frames = await page.evaluate(
      () => (window as unknown as { nextFrames: string[] }).nextFrames,
    );
    record('next-in-place', { first, pressed, waiting, spot, frames });
    expect(pressed.disabled).toBe(true);
    expect(waiting).toHaveLength(1);
    expect(waiting).not.toEqual(first);
    // A moment later it is decided by a press.
    await expect(next).toBeEnabled({ timeout: 2_000 });
    await next.click();
    // A command of two lines is more than the line can say: View alone, and its card decides.
    await expect(activityLine(page)).toContainText('echo one', { timeout: 30_000 });
    await waitForStill(page);
    const multi = await lineParts(page);
    record('multi-line', multi);
    expect(multi?.decisions).toEqual([]);
    await activityLine(page).getByRole('button', { name: 'View', exact: true }).click();
    const card = tray.locator('[data-testid^="approval-"]');
    await expect(card).toContainText('echo two');
    await card.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect.poll(pending, { timeout: 30_000 }).toEqual([]);
    await expect(bar).toHaveAttribute('data-run', 'succeeded', { timeout: 30_000 });
    expect(corral.errors).toEqual([]);
  } finally {
    await session.cleanup();
  }
});

/** The command of ⑦: whole beside the buttons at 1280, cut once the run's state comes in. */
const BUILD = 'npm run build --workspace=apps/studio';

for (const reduced of [false, true])
  test(`⑦ scrolled up a notch at a time, the buttons leave as the call is cut and come back${reduced ? ', reduced motion' : ''}`, async ({
    page,
    corral,
  }) => {
    test.setTimeout(240_000);
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    corral.fake?.setResponses([
      fauxAssistantMessage([fauxToolCall('run_command', { command: BUILD })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Done.'),
      fauxAssistantMessage('Done.'),
      fauxAssistantMessage('Done.'),
    ]);
    const session = await commandSession(page, corral);
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await requestBox(page).fill('Check the folder.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const tray = page.locator('[data-pending-tray]');
      await expect(tray.locator('[data-testid^="approval-"]')).toHaveCount(1, { timeout: 30_000 });
      // The conversation's end, a card waiting in it, comes to rest.
      await waitForStill(page);
      const bar = activityBar(page);
      const timeline = page.getByTestId('chat-timeline');
      await timeline.hover({ position: { x: 16, y: 120 } });
      const pending = () => {
        const run = corral.server.coordinator.listRuns()[0];
        return run
          ? Object.values(corral.server.coordinator.getSnapshot(run.runId).projection.approvals)
              .filter((approval) => approval.status === 'pending')
              .map((approval) => approval.approvalId)
          : [];
      };
      const allow = `Allow once · Run · ${BUILD}`;
      // From the end, a notch at a time: the card leaves first, then the run's row, whose state
      // then comes to the line beside the words.
      const upToState = async (name: string) => {
        await timeline.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        await waitForStill(page, { stillMs: 600 });
        await timeline.hover({ position: { x: 16, y: 120 } });
        const steps: unknown[] = [];
        let spot: { x: number; y: number } | null = null;
        for (let step = 0; step < 60; step += 1) {
          await page.mouse.wheel(0, -100);
          await page.waitForTimeout(250);
          if ((await bar.getAttribute('data-line')) !== 'waiting') continue;
          const parts = await lineParts(page);
          steps.push({ step, ...parts });
          record(name, steps);
          // Never a decision beside words it cuts.
          if (parts?.decisions.length) expect.soft(parts.cut, `step ${step}: cut`).toBe(false);
          const button = activityLine(page).getByRole('button', { name: allow, exact: true });
          if (!spot && !parts?.state && (await button.count())) {
            const box = await button.boundingBox();
            if (box) spot = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          }
          if (parts?.state) return spot;
        }
        throw new Error('The run row never left');
      };
      const spot = await upToState(`step-by-step${reduced ? '-reduced' : ''}`);
      if (!spot) throw new Error('The whole call never had its buttons');
      await waitForStill(page, { stillMs: 600 });
      // The state beside it leaves the call less room than it needs beside the buttons: View
      // alone, the words whole in the room the buttons left.
      const cut = await lineParts(page);
      expect(cut?.state).toBeTruthy();
      expect(cut?.decisions).toEqual([]);
      expect(cut?.cut).toBe(false);
      await expect(
        activityLine(page).getByRole('button', { name: 'View', exact: true }),
      ).toBeVisible();
      // Pressed where Allow once was, nothing is decided.
      const before = pending();
      await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(300);
      expect(pending()).toEqual(before);
      if ((await bar.locator('[data-activity-toggle]').getAttribute('aria-expanded')) === 'true')
        await page.keyboard.press('Escape');
      // Up again to where the state cuts the call, then down in finer notches: the run's row
      // comes back before the card does, the words are whole beside the buttons, and they return.
      await upToState(`again${reduced ? '-reduced' : ''}`);
      await waitForStill(page, { stillMs: 600 });
      let back = false;
      const down: unknown[] = [];
      for (let step = 0; step < 40 && !back; step += 1) {
        await page.mouse.wheel(0, 20);
        await page.waitForTimeout(250);
        const parts = await lineParts(page);
        down.push({ step, line: await bar.getAttribute('data-line'), ...parts });
        record(`back-down${reduced ? '-reduced' : ''}`, down);
        if ((await bar.getAttribute('data-line')) !== 'waiting') break;
        if (parts?.decisions.length) expect.soft(parts.cut, 'back down: cut').toBe(false);
        back = !parts?.state && !parts?.cut && Boolean(parts?.decisions.length);
      }
      expect(back, 'whole again, the buttons came back').toBe(true);
      await activityLine(page).getByRole('button', { name: allow, exact: true }).click();
      await expect.poll(pending, { timeout: 30_000 }).toEqual([]);
      expect(corral.errors).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

/** How often the line's decision buttons come or go while it is watched for `ms`. */
function flips(page: Page, ms: number) {
  return page.evaluate(
    (wait) =>
      new Promise<number>((resolve) => {
        const line = document.querySelector(
          '[data-testid="activity-bar"] [data-activity-bar] > div',
        );
        if (!line) return resolve(-1);
        const count = () =>
          [...line.querySelectorAll('button')].filter(
            (button) =>
              !button.closest('[inert]') && / · /.test(button.getAttribute('aria-label') ?? ''),
          ).length;
        let last = count();
        let changes = 0;
        const observer = new MutationObserver(() => {
          const now = count();
          if (now !== last) changes += 1;
          last = now;
        });
        observer.observe(line, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(changes);
        }, wait);
      }),
    ms,
  );
}

test('⑧ at the edge of fitting, a twentieth of a pixel at a time, the buttons settle and stay', async ({
  page,
  corral,
}) => {
  test.setTimeout(240_000);
  corral.fake?.setResponses([
    fauxAssistantMessage([fauxToolCall('run_command', { command: BUILD })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage('Done.'),
  ]);
  const session = await commandSession(page, corral);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // Letters a fiftieth of a pixel wider: the words and the buttons measure in fractions, as on
    // a scaled display.
    await page.evaluate(() => {
      document.documentElement.style.letterSpacing = '0.02px';
    });
    await requestBox(page).fill('Check the folder.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const tray = page.locator('[data-pending-tray]');
    await expect(tray.locator('[data-testid^="approval-"]')).toHaveCount(1, { timeout: 30_000 });
    await waitForStill(page);
    const bar = activityBar(page);
    const timeline = page.getByTestId('chat-timeline');
    await timeline.hover({ position: { x: 16, y: 120 } });
    // The card off screen, the run's row still on it: the call whole beside its buttons.
    for (let step = 0; step < 40; step += 1) {
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(250);
      if ((await bar.getAttribute('data-line')) === 'waiting') break;
    }
    await waitForStill(page, { stillMs: 600 });
    const shown = async () => ((await lineParts(page))?.decisions.length ?? 0) > 0;
    expect(await shown()).toBe(true);
    // The line narrowed from its right end, a pixel at a time, to where the buttons leave.
    const pad = (px: number) =>
      page.evaluate((value) => {
        const row = document.querySelector<HTMLElement>(
          '[data-testid="activity-bar"] [data-activity-bar] > div',
        );
        if (row) row.style.paddingRight = `${value}px`;
      }, px);
    let edge = 0;
    for (let px = 12; px < 300 && !edge; px += 1) {
      await pad(px);
      await page.waitForTimeout(40);
      if (!(await shown())) edge = px;
    }
    expect(edge, 'the buttons leave somewhere').toBeGreaterThan(0);
    // Across the edge both ways, a twentieth of a pixel at a time, watched three seconds in all.
    const scan: { px: number; flips: number; shown: boolean }[] = [];
    const across = [
      ...Array.from({ length: 30 }, (_, i) => edge - 1.5 + i * 0.05),
      ...Array.from({ length: 30 }, (_, i) => edge + 0.5 - i * 0.05),
    ];
    for (const px of across) {
      await pad(px);
      // The first frame at a new width may answer anew; after it, nothing changes.
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      scan.push({
        px: Math.round(px * 100) / 100,
        flips: await flips(page, 50),
        shown: await shown(),
      });
    }
    record('edge', { edge, scan });
    expect(scan.filter((step) => step.flips > 0)).toEqual([]);
    // The call is decided and the run ends: nothing is left waiting on a timer past the scene.
    await pad(12);
    const allow = activityLine(page).getByRole('button', {
      name: `Allow once · Run · ${BUILD}`,
      exact: true,
    });
    await expect(allow).toBeEnabled();
    await allow.click();
    await expect(bar).toHaveAttribute('data-run', 'succeeded', { timeout: 30_000 });
    expect(corral.errors).toEqual([]);
  } finally {
    await session.cleanup();
  }
});

test('⑨ on a slow machine with reduced motion, a press where View stood alone decides nothing for a moment', async ({
  page,
  corral,
}) => {
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  corral.fake?.setResponses([
    fauxAssistantMessage([fauxToolCall('run_command', { command: 'echo tray-ok' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage('Done.'),
  ]);
  const session = await commandSession(page, corral);
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await requestBox(page).fill('Check the folder.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const tray = page.locator('[data-pending-tray]');
    const card = tray.locator('[data-testid^="approval-"]');
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await waitForStill(page);
    const bar = activityBar(page);
    const pending = () => {
      const run = corral.server.coordinator.listRuns()[0];
      return run
        ? Object.values(corral.server.coordinator.getSnapshot(run.runId).projection.approvals)
            .filter((approval) => approval.status === 'pending')
            .map((approval) => approval.approvalId)
        : [];
    };
    const before = pending();
    expect(before).toHaveLength(1);
    // Six times slower. Every frame of the line is watched. From the first frame View stands
    // alone on the waiting line, and for the next 0.6 s, the spot it stood on is pressed as soon
    // as a decision button stands there.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await page.evaluate(() => {
      type Press = { after: number; name: string | null; disabled: boolean };
      const w = window as unknown as {
        viewAt: number | null;
        press: Press | null;
        frames: string[];
      };
      w.viewAt = null;
      w.press = null;
      w.frames = [];
      let spot: { x: number; y: number } | null = null;
      const named = (button: Element | null) =>
        / · /.test(button?.getAttribute('aria-label') ?? '') ? (button as HTMLButtonElement) : null;
      const tick = () => {
        const line = document.querySelector(
          '[data-testid="activity-bar"][data-line="waiting"] [data-activity-bar] > div',
        );
        const buttons = [...(line?.querySelectorAll('button') ?? [])].filter(
          (button) => !button.closest('[inert]'),
        );
        const frame = buttons
          .map((button) => `${button.textContent}${button.disabled ? ' (off)' : ''}`)
          .join(' | ');
        if (w.frames.at(-1) !== frame) w.frames.push(frame);
        const view = buttons.find((button) => button.textContent === 'View');
        if (!spot && view && !buttons.some((button) => named(button))) {
          const box = view.getBoundingClientRect();
          spot = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
          w.viewAt = performance.now();
        }
        if (spot && w.viewAt !== null && !w.press && performance.now() - w.viewAt < 600) {
          const under = named(document.elementFromPoint(spot.x, spot.y)?.closest('button') ?? null);
          if (under) {
            w.press = {
              after: Math.round(performance.now() - w.viewAt),
              name: under.getAttribute('aria-label'),
              disabled: under.disabled,
            };
            under.click();
          }
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
    // The reader leaves the card already read.
    const timeline = page.getByTestId('chat-timeline');
    await timeline.hover({ position: { x: 16, y: 120 } });
    for (let step = 0; step < 8; step += 1) await page.mouse.wheel(0, -500);
    // The line comes to its buttons, and the 0.6 s after any View alone before them goes by.
    await expect(
      activityLine(page).getByRole('button', { name: 'Allow once · Run · echo tray-ok' }),
    ).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_500);
    const seen = await page.evaluate(() => {
      const w = window as unknown as { viewAt: number | null; press: unknown; frames: string[] };
      return { viewAlone: w.viewAt !== null, press: w.press, frames: w.frames };
    });
    const after = pending();
    record('slow-reduced', { seen, before, after });
    // Whatever came where View stood alone, a press there in the next 0.6 s decided nothing.
    expect(after).toEqual(before);
    // And the call, whole beside its buttons, came with them in its first frame: never View alone.
    expect(seen.viewAlone).toBe(false);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    // The call is decided on its card and the run ends.
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect.poll(pending, { timeout: 30_000 }).toEqual([]);
    await expect(bar).toHaveAttribute('data-run', 'succeeded', { timeout: 30_000 });
    expect(corral.errors).toEqual([]);
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
    await session.cleanup();
  }
});

test('⑩ open, the work plan keeps its height as its steps go from waiting to working to done', async ({
  page,
  corral,
}) => {
  test.setTimeout(240_000);
  const gates = [hold(), hold(), hold(), hold()];
  const projection = () => {
    const run = corral.server.coordinator.listRuns()[0];
    return run ? corral.server.coordinator.getSnapshot(run.runId).projection : null;
  };
  type Step = 'pending' | 'in_progress' | 'completed';
  const plan = (revision: number, look: Step, fix: Step) =>
    fauxToolCall('update_plan', {
      scope: 'execution',
      expectedRevision: revision,
      criteriaVersionId: projection()?.currentCriteriaVersionId ?? null,
      items: [
        { id: 'look', title: 'Look at the login path', status: look },
        { id: 'fix', title: 'Fix the slow call', status: fix },
      ],
    });
  const states: [Step, Step][] = [
    ['pending', 'pending'],
    ['in_progress', 'pending'],
    ['completed', 'in_progress'],
    ['completed', 'completed'],
  ];
  // Each request writes the plan's next state, then the next request is held until it is let go.
  corral.fake?.setResponses([
    ...states.map(([look, fix], index) => async () => {
      if (index > 0) {
        gates[index - 1]?.reach();
        await gates[index - 1]?.opened;
      }
      return fauxAssistantMessage([plan(index, look, fix)], { stopReason: 'toolUse' });
    }),
    async () => {
      gates[3]?.reach();
      await gates[3]?.opened;
      return fauxAssistantMessage('Done.');
    },
    fauxAssistantMessage('Done.'),
  ] as never);
  await page.setViewportSize({ width: 1280, height: 800 });
  await corral.open('/projects/default');
  await newConversation(page);
  await requestBox(page).fill('Find why login is slow');
  await requestBox(page).press('Enter');
  await gates[0]?.reached;
  await openActivity(page);
  const section = activityBar(page).getByTestId('composer-work-plan');
  const items = section.locator('[data-plan-item]');
  await expect(items).toHaveCount(2, { timeout: 30_000 });
  await waitForStill(page);
  // Every frame from here: the plan's height, and the whole bar's.
  await page.evaluate(() => {
    const w = window as unknown as { planFrames: { plan: number; bar: number; text: string }[] };
    w.planFrames = [];
    const tick = () => {
      const bar = document.querySelector('[data-testid="activity-bar"]');
      const plan = bar?.querySelector('[data-testid="composer-work-plan"]');
      w.planFrames.push({
        plan: plan?.getBoundingClientRect().height ?? -1,
        bar: bar?.getBoundingClientRect().height ?? -1,
        text: (plan?.textContent ?? '').slice(0, 120),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const statuses = () => items.evaluateAll((nodes) => nodes.map((node) => node.dataset.status));
  for (const [index, want] of [
    ['active', 'pending'],
    ['done', 'active'],
    ['done', 'done'],
  ].entries()) {
    gates[index]?.open();
    await expect.poll(statuses, { timeout: 30_000 }).toEqual(want);
    await gates[index + 1]?.reached;
    await waitForStill(page);
  }
  const frames = await page.evaluate(
    () =>
      (window as unknown as { planFrames: { plan: number; bar: number; text: string }[] })
        .planFrames,
  );
  const heights = [...new Set(frames.map((frame) => frame.plan))];
  const bars = [...new Set(frames.map((frame) => frame.bar))];
  const odd = frames.filter((frame) => frame.plan !== frames[0]?.plan).slice(0, 5);
  record('plan-height', { heights, bars, frames: frames.length, odd });
  expect(frames.length).toBeGreaterThan(30);
  expect(heights, 'the plan section kept one height').toHaveLength(1);
  expect(bars, 'the bar kept one height').toHaveLength(1);
  gates[3]?.open();
  await expect(activityBar(page)).toHaveAttribute('data-run', 'succeeded', { timeout: 30_000 });
  expect(corral.errors).toEqual([]);
});

type LineFrame = {
  at: number;
  line: string | null;
  label: string | null;
  text: string;
  /** Where the newest run row's label stands in the conversation's view, and how far the view is from its end. */
  row?: string;
  gap?: number;
};

/** Every frame from now on: the closed line's kind, the state it writes for an unseen row, and its words. */
function watchClosedLine(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { lineFrames: LineFrame[]; lineStart: number };
    w.lineFrames = [];
    w.lineStart = performance.now();
    const tick = () => {
      const bar = document.querySelector('[data-testid="activity-bar"]');
      const row = bar?.querySelector('[data-activity-bar] > div');
      const frame = {
        at: Math.round(performance.now() - w.lineStart),
        line: bar?.getAttribute('data-line') ?? null,
        label:
          row?.querySelector('[data-presence-label]')?.getAttribute('data-presence-label') ?? null,
        text: ((row as HTMLElement | null)?.innerText ?? '').replace(/\n/g, ' | ').slice(0, 120),
        ...(() => {
          const timeline = document.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
          const label = [...(timeline?.querySelectorAll('[data-presence-label^="run:"]') ?? [])].at(
            -1,
          );
          const view = timeline?.getBoundingClientRect();
          const box = label?.getBoundingClientRect();
          const place =
            !label || !view || !box
              ? 'none'
              : box.top >= view.bottom
                ? 'below'
                : box.bottom <= view.top
                  ? 'above'
                  : 'in';
          const gap = timeline
            ? Math.round(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight)
            : -1;
          return { row: place, gap };
        })(),
      };
      const last = w.lineFrames.at(-1);
      if (
        !last ||
        last.line !== frame.line ||
        last.label !== frame.label ||
        last.text !== frame.text ||
        last.row !== frame.row
      )
        w.lineFrames.push(frame);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const closedLineFrames = (page: Page) =>
  page.evaluate(() => (window as unknown as { lineFrames: LineFrame[] }).lineFrames.slice());

// The run list answering late (as under load) leaves the request's entry ahead of its run in the
// conversation: the run row's place comes with the entry, and the line does not say its state.
for (const [cpu, listLag] of [
  [1, 0],
  [4, 0],
  [1, 2_500],
] as const)
  test(`⑪ following the end, the line never points at a row or card that came in view${cpu > 1 ? `, ${cpu}× slower` : ''}${listLag ? ', its run listed late' : ''}`, async ({
    page,
    corral,
  }) => {
    test.setTimeout(240_000);
    const working = hold();
    corral.fake?.setResponses([
      async () => {
        working.reach();
        await working.opened;
        return fauxAssistantMessage([fauxToolCall('run_command', { command: 'echo tray-ok' })], {
          stopReason: 'toolUse',
        });
      },
      fauxAssistantMessage('Done.'),
      fauxAssistantMessage('Done.'),
      fauxAssistantMessage('Done.'),
    ] as never);
    const session = await commandSession(page, corral);
    const cdp = await page.context().newCDPSession(page);
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await waitForStill(page);
      const pending = () => {
        const run = corral.server.coordinator.listRuns()[0];
        return run
          ? Object.values(corral.server.coordinator.getSnapshot(run.runId).projection.approvals)
              .filter((approval) => approval.status === 'pending')
              .map((approval) => approval.approvalId)
          : [];
      };
      if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      if (listLag)
        await page.route(/\/runs$/, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          const response = await route.fetch();
          await new Promise((done) => setTimeout(done, listLag));
          await route.fulfill({ response });
        });
      // (a) A request sent at the followed end: its run row and its working role come in view.
      await watchClosedLine(page);
      await requestBox(page).fill('Check the folder.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await working.reached;
      await expect(
        page.locator('[data-chat-item] [data-presence-label^="run:"]').last(),
      ).toBeInViewport({
        timeout: 30_000,
      });
      await page.waitForTimeout(1_500);
      const arriving = await closedLineFrames(page);
      // (b) The role's call waits on an approval: its card comes at the followed end, in view.
      await watchClosedLine(page);
      working.open();
      const card = page.locator('[data-pending-tray] [data-testid^="approval-"]');
      await expect(card).toBeInViewport({ timeout: 30_000 });
      await page.waitForTimeout(1_500);
      const carded = await closedLineFrames(page);
      const variant = `${cpu > 1 ? `-cpu${cpu}` : ''}${listLag ? '-listed-late' : ''}`;
      record(`arrival${variant}`, { arriving, carded });
      // Its own file too: the scenes of other workers write the shared record.
      writeFileSync(
        join(OUT, `activity-bar-arrival${variant}-${test.info().repeatEachIndex}.json`),
        `${JSON.stringify({ arriving, carded }, null, 2)}\n`,
      );
      // Whatever came was in view: never a role named as off screen, never a run or role state
      // written for a row the person sees, never the waiting line for a card in view.
      const pointing = (frames: LineFrame[]) =>
        frames.filter((frame) => frame.line === 'role' || frame.line === 'waiting' || frame.label);
      expect(pointing(arriving), 'a row in view pointed at').toEqual([]);
      expect(pointing(carded), 'a card in view pointed at').toEqual([]);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await card.getByRole('button', { name: 'Allow once', exact: true }).click();
      await expect.poll(pending, { timeout: 30_000 }).toEqual([]);
      await expect(activityBar(page)).toHaveAttribute('data-run', 'succeeded', { timeout: 30_000 });
      expect(corral.errors).toEqual([]);
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
      await session.cleanup();
    }
  });
