import type { Locator, Page } from '@playwright/test';
import { requestBox, slash } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

// A held run keeps its controls in the top bar and its saved requests in the queue; both stay
// reachable on a phone-width screen and from the keyboard.

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

async function holdRun(page: Page, corral: Harness) {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await requestBox(page).fill('Read the notes and wait');
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

  test('keeps the top bar inside a 390px screen with Pause and Cancel reachable', async ({
    page,
    corral,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await holdRun(page, corral);
    const controls = page.getByRole('region', { name: 'Active run controls', exact: true });
    const pause = controls.getByRole('button', { name: 'Pause run', exact: true });
    const cancel = controls.getByRole('button', { name: 'Cancel whole run', exact: true });
    await expect(page.getByTestId('dock-open-active-run')).toBeVisible();
    if (process.env.CORRAL_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.CORRAL_SCREENSHOT_DIR}/topbar-390.png` });
    await expect.poll(() => shown(pause)).toBe(true);
    await expect.poll(() => shown(cancel)).toBe(true);
    await expect.poll(() => shown(page.getByTestId('dock-open-active-run'))).toBe(true);
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
    // Icon-only at this width, the controls still say what they do.
    await pause.hover();
    await expect(page.getByRole('tooltip')).toContainText('Pause run');
    await cancel.click();
    await expect(
      page.getByRole('button', { name: 'Confirm whole run cancellation', exact: true }),
    ).toBeVisible();
    expect(corral.errors).toEqual([]);
  });

  test('fans the queue out for the keyboard and shows each card’s actions as they take focus', async ({
    page,
    corral,
  }) => {
    await holdRun(page, corral);
    const box = requestBox(page);
    const texts = ['First saved', 'Second saved', 'Third saved', 'Fourth saved'];
    for (const text of texts) {
      await slash(page, 'queue');
      await box.fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Queued next tasks' })).toContainText(text);
    }
    const queue = page.getByRole('region', { name: 'Queued next tasks' });
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
