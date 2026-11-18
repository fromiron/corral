import type { Locator, Page } from '@playwright/test';
import {
  closePanel,
  confirmStop,
  openActivity,
  openPanelTab,
  panelContent,
  panelToggle,
  requestBox,
  runControls,
  runGoing,
  sendPlaceStop,
  stopConfirmation,
} from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

// A held run keeps its controls in the composer's activity bar, never in the top bar, and its
// saved requests in the queue; all stay reachable on a phone-width screen and from the keyboard.

/** On top at its centre, and drawn: no ancestor fades it out. */
async function shown(target: Locator) {
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    for (let el: Element | null = node; el; el = el.parentElement)
      if (Number(getComputedStyle(el).opacity) < 0.99) return false;
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return top !== null && (top === node || node.contains(top));
  });
}

/** Starts a run that holds; its request names the conversation. */
async function holdRun(page: Page, corral: Harness, request = 'Read the notes and wait') {
  await corral.open('/');
  await page
    .getByRole('main')
    .getByRole('button', { name: 'New conversation', exact: true })
    .click();
  await requestBox(page).fill(request);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('running');
}

test.describe('a held run', () => {
  let reply = Promise.resolve();
  let release = () => {};
  test.use({ agentReply: { reply: () => 'Done', beforeReply: () => reply } });
  test.beforeEach(() => {
    reply = new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  test.afterEach(() => release());

  test('keeps the top bar inside a 390px screen with Pause and Stop reachable', async ({
    page,
    corral,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await holdRun(page, corral);
    await expect(runGoing(page)).toBeVisible();
    // The top bar has no run state or run control.
    const top = page.getByRole('banner');
    await expect(top.getByRole('button', { name: /Pause|Stop/ })).toHaveCount(0);
    await openActivity(page);
    const pause = runControls(page).getByRole('button', { name: 'Pause', exact: true });
    // Nothing is written: Stop is Send's place, and only there (composer-flow.md "활동 바").
    const stop = sendPlaceStop(page);
    await expect(runControls(page).getByRole('button', { name: 'Stop' })).toHaveCount(0);
    if (process.env.CORRAL_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.CORRAL_SCREENSHOT_DIR}/topbar-390.png` });
    await expect.poll(() => shown(pause)).toBe(true);
    await expect.poll(() => shown(stop)).toBe(true);
    const overflow = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('.app-topbar');
      const parts = [...(bar?.querySelectorAll<HTMLElement>('button, a, [role="status"]') ?? [])]
        .filter((node) => node.getClientRects().length)
        .map((node) => node.getBoundingClientRect())
        .filter((box) => box.left < -1 || box.right > window.innerWidth + 1);
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        bar: bar ? bar.scrollWidth - bar.clientWidth : 0,
        outside: parts.length,
      };
    });
    expect(overflow).toEqual({ page: 0, bar: 0, outside: 0 });
    // The controls say what they do in words at this width too.
    await expect(pause).toHaveText('Pause');
    // The scripted assistant works with its two helpers, so Stop asks first; keeping the run
    // leaves it running.
    await stop.click();
    const ask = stopConfirmation(page);
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Keep running' }).click();
    await expect(ask).toHaveCount(0);
    expect(corral.server.coordinator.listRuns()[0]?.status).toBe('running');
    await stop.click();
    await confirmStop(page);
    await expect
      .poll(() => corral.server.coordinator.listRuns()[0]?.status)
      .toMatch(/^(cancelling|cancelled)$/);
    expect(corral.errors).toEqual([]);
  });

  test('gives way in order as the bar narrows and keeps the session name and Search', async ({
    page,
    corral,
  }) => {
    const tiers = ['full', 'short-path', 'project-icon', 'two-rows'];
    await page.setViewportSize({ width: 1600, height: 800 });
    // The bar holds the path, the session's tools and Search: a name long enough to shorten is
    // what makes it give way before the narrowest widths.
    await holdRun(
      page,
      corral,
      'Read the release notes of every package in this project, then wait for my answer',
    );
    const bar = page.getByRole('banner');
    const name = bar.getByRole('heading', { level: 2 });
    const search = bar.getByRole('button', { name: 'Search', exact: true });
    // The panel's toggle never folds into the bar's menu (features/session-panel.md 화면 틀).
    const toggle = panelToggle(page);
    const tier = async () => tiers.indexOf((await bar.getAttribute('data-topbar-tier')) ?? '');
    await expect(bar).toHaveAttribute('data-topbar-tier', 'full');
    // The run's controls stay with the composer, open at every width.
    await openActivity(page);
    const pause = runControls(page).getByRole('button', { name: 'Pause', exact: true });
    const title = (await name.innerText()).trim();
    // The bar is fitted to its own width: beside the sidebar from 1024, full width below.
    const seen: { bar: number; tier: number }[] = [];
    for (const width of [1440, 1280, 1100, 1024, 900, 700, 520, 390]) {
      await page.setViewportSize({ width, height: 800 });
      // The bar settles on a tier that fits: nothing leaves it or the page.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const node = document.querySelector<HTMLElement>('.app-topbar');
            return node
              ? Math.max(
                  node.scrollWidth - node.clientWidth,
                  document.documentElement.scrollWidth - window.innerWidth,
                )
              : -1;
          }),
        )
        .toBe(0);
      seen.push({ bar: (await bar.boundingBox())?.width ?? 0, tier: await tier() });
      await expect(name, `${width}px`).toBeVisible();
      await expect(name, `${width}px`).toContainText(title.slice(0, 8));
      expect((await name.boundingBox())?.width ?? 0, `${width}px`).toBeGreaterThan(80);
      await expect.poll(() => shown(search), { message: `${width}px` }).toBe(true);
      await expect.poll(() => shown(toggle), { message: `${width}px` }).toBe(true);
      await expect.poll(() => shown(pause), { message: `${width}px` }).toBe(true);
      await expect(bar.getByRole('button', { name: /Pause|Stop/ })).toHaveCount(0);
    }
    // A narrower bar never brings back what a wider one had already given up.
    const byWidth = [...seen].sort((a, b) => b.bar - a.bar).map((entry) => entry.tier);
    expect(byWidth).toEqual([...byWidth].sort((a, b) => a - b));
    expect(new Set(byWidth).size).toBeGreaterThanOrEqual(3);
    // With no room beside the conversation, the toggle still opens the panel: the run's tab
    // comes as a drawer, and closing it gives the conversation back.
    await page.setViewportSize({ width: 520, height: 800 });
    await openPanelTab(page, 'Runs');
    await expect(panelContent(page, 'Run #1')).toBeVisible();
    await closePanel(page);
    await expect(requestBox(page)).toBeVisible();
    // Room given back returns what was folded.
    await page.setViewportSize({ width: 1600, height: 800 });
    await expect(bar).toHaveAttribute('data-topbar-tier', 'full');
    await expect(toggle).toBeVisible();
    // The toggle's name shows in its tooltip on hover and on keyboard focus (workbench.md: "주요
    // 아이콘의 이름은 호버와 키보드 포커스 모두에서 툴팁으로 확인할 수 있다").
    const named = page.getByRole('tooltip', { name: 'Show or hide the panel' });
    await toggle.hover();
    await expect(named).toBeVisible();
    await page.mouse.move(700, 700);
    await page.keyboard.press('Tab');
    await toggle.focus();
    await expect(named).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-describedby', /.+/);
    await page.keyboard.press('Escape');
    await expect(named).toBeHidden();
    expect(corral.errors).toEqual([]);
  });

  test('fans the queue out for the keyboard and shows each card’s actions as they take focus', async ({
    page,
    corral,
  }) => {
    await holdRun(page, corral);
    const box = requestBox(page);
    const texts = ['First saved', 'Second saved', 'Third saved', 'Fourth saved'];
    // Each next request (Alt+Enter) sent while the run works waits behind it. The tool line
    // says so once the composer follows the run.
    await expect(page.locator('[data-slot="composer-keys"]')).toContainText('Next');
    for (const text of texts) {
      await box.fill(text);
      await box.press('Alt+Enter');
      await expect(page.getByRole('region', { name: 'Queued next tasks' })).toContainText(text);
    }
    const queue = page.getByRole('region', { name: 'Queued next tasks' });
    // Left on, the server would start the first one when the run ends.
    await queue
      .getByRole('switch', { name: 'Start the next queued task when the run ends', exact: true })
      .click();
    // The card around a queued text (the text itself ignores the pointer).
    const card = (text: string) => queue.getByText(text, { exact: true }).locator('..');
    // Once the run ends, Start now is offered on every card and joins the tab order.
    release();
    await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
    await expect(queue.getByRole('button', { name: 'Start now', exact: true })).toHaveCount(4);
    for (const start of await queue.getByRole('button', { name: 'Start now', exact: true }).all())
      await expect(start).toBeEnabled();
    await page.mouse.move(0, 0);
    // Collapsed, the cards past the peek are hidden.
    await expect.poll(() => shown(card('Fourth saved'))).toBe(false);
    await queue
      .getByRole('switch', { name: 'Start the next queued task when the run ends', exact: true })
      .focus();
    const seen = new Set<string>();
    let starts = 0;
    for (let step = 0; step < 16; step += 1) {
      await page.keyboard.press('Tab');
      const focused = page.locator(':focus');
      if (!(await queue.locator(':focus').count())) break;
      // Focus inside fans every card out.
      for (const text of texts) await expect.poll(() => shown(card(text))).toBe(true);
      await expect.poll(() => shown(focused)).toBe(true);
      const name = (await focused.getAttribute('aria-label')) ?? (await focused.innerText());
      if (name === 'Start now') starts += 1;
      seen.add(name);
    }
    for (const text of texts) {
      expect(seen).toContain(`Edit queued request: ${text}`);
      expect(seen).toContain(`Remove queued request: ${text}`);
    }
    expect([...seen].filter((name) => name === 'Start now')).toHaveLength(1);
    expect(starts).toBe(4);
    // Leaving the queue folds it again.
    await box.focus();
    await expect.poll(() => shown(card('Fourth saved'))).toBe(false);
    expect(corral.errors).toEqual([]);
  });
});
