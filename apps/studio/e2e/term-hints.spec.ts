import { linearCorral } from '@corral/testkit';
import { expect, type Locator, type Page, test } from '@playwright/test';
import en from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import { importTeam, newConversationFromSidebar, openSettings, startTestRun } from './workbench.ts';

// Coined terms explain themselves where they stand as names (docs/specs/features/term-hints.md).
// Only what needs a real browser: a touch press on the icon and the line it stands on, the real
// keyboard around an open explanation, and the icons a whole screen draws.

const about = (term: keyof typeof en.Terms & string) =>
  en.Terms.about.replace('{term}', (en.Terms[term] as { name: string }).name);
const popup = (page: Page) => page.locator('[data-term-popup]');

/** What has the focus: its tag and its name. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return `${active?.tagName ?? ''}|${active?.getAttribute('aria-label') ?? active?.textContent ?? ''}`;
  });

/**
 * Opened by focus, one Tab and one Shift+Tab each go straight on to a control beside the icon,
 * never through the page itself, and the explanation closes. A pointer that passed over the icon
 * and away meanwhile leaves it open and changes nothing about where the keys go.
 */
async function keyboardAround(page: Page, icon: Locator, within: Locator) {
  const name = await icon.getAttribute('aria-label');
  const stops: Record<string, string> = {};
  for (const pointerPassed of [false, true]) {
    for (const key of ['Tab', 'Shift+Tab']) {
      const step = `${key}${pointerPassed ? ' after a pointer passed' : ''}`;
      await icon.focus();
      await expect(popup(page)).toBeVisible();
      if (pointerPassed) {
        await icon.hover();
        await page.waitForTimeout(400);
        await page.mouse.move(2, 2);
        await page.waitForTimeout(400);
        // The focus stayed, so the explanation did too.
        await expect(popup(page), step).toBeVisible();
      }
      await page.keyboard.press(key);
      const now = await focused(page);
      expect(now.startsWith('BODY'), `${step} from the open explanation`).toBe(false);
      expect(now, step).not.toBe(`BUTTON|${name}`);
      expect(await within.evaluate((node) => node.contains(document.activeElement)), step).toBe(
        true,
      );
      if (pointerPassed) expect(now, step).toBe(stops[key]);
      else stops[key] = now;
      await expect(popup(page), step).toHaveCount(0);
    }
  }
}

/**
 * Opened by focus with the pointer resting on the icon, a Tab moves the focus on but the pointer
 * is still there: it stays open until the pointer leaves too.
 */
async function pointerOutlastsFocus(page: Page, icon: Locator) {
  await icon.focus();
  await expect(popup(page)).toBeVisible();
  await icon.hover();
  await page.waitForTimeout(400);
  await page.keyboard.press('Tab');
  await expect(icon).not.toBeFocused();
  await page.waitForTimeout(400);
  await expect(popup(page)).toBeVisible();
  await page.mouse.move(2, 2);
  await expect(popup(page)).toHaveCount(0);
}

/** A line's box and where the content after it starts, with the icon and with it taken out. */
async function lineWithAndWithout(icon: Locator, line: Locator, after: Locator) {
  const measure = async () => ({
    line: (await line.boundingBox())?.height,
    after: (await after.boundingBox())?.y,
  });
  const withIcon = await measure();
  await icon.evaluate((node) => {
    (node as HTMLElement).style.display = 'none';
  });
  const without = await measure();
  await icon.evaluate((node) => {
    (node as HTMLElement).style.display = '';
  });
  return { withIcon, without };
}

/** The term of each info icon on the screen, counted. */
async function icons(page: Page) {
  const terms = await page
    .locator('[data-term-hint]')
    .evaluateAll((all) => all.map((icon) => (icon as HTMLElement).dataset.termHint ?? ''));
  const counts: Record<string, number> = {};
  for (const term of terms) counts[term] = (counts[term] ?? 0) + 1;
  return counts;
}

test.describe('on a touch screen', () => {
  // Wide enough that the settings title, and its icon, are drawn.
  test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

  test('a press opens a term’s explanation and a press outside closes it', async ({ page }) => {
    await page.goto('/');
    const dialog = await openSettings(page, en.Harness.heading);
    const icon = dialog.getByRole('button', { name: about('workStyle'), exact: true });
    await icon.tap();
    await expect(popup(page)).toBeVisible();
    await expect(popup(page).locator('[data-term-meaning]')).toHaveText(en.Terms.workStyle.meaning);
    const title = dialog.getByRole('heading', { level: 2, name: en.Harness.heading });
    await title.tap();
    await expect(popup(page)).toHaveCount(0);
    // It stays closed: nothing hands the focus back to the icon to open it again.
    await expect(popup(page)).toHaveCount(0, { timeout: 1000 });
    await expect(icon).toBeVisible();
  });

  test('the icon gets a finger-sized target and leaves its line as tall as before', async ({
    page,
  }) => {
    await page.goto('/');
    const dialog = await openSettings(page, en.Harness.heading);
    const icon = dialog.locator('[data-term-hint="workStyle"]');
    expect((await icon.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const header = dialog.locator('[data-settings-header]');
    const settings = await lineWithAndWithout(
      icon,
      header,
      header.locator('xpath=following-sibling::*[1]'),
    );
    expect(settings.withIcon).toEqual(settings.without);

    await importTeam(page, linearCorral(['writer']));
    await startTestRun(page);
    const execution = page.locator('[data-term-hint="execution"]');
    const head = execution.locator('xpath=ancestor::header[1]');
    const tree = await lineWithAndWithout(
      execution,
      head,
      head.locator('xpath=following-sibling::*[1]'),
    );
    expect(tree.withIcon).toEqual(tree.without);
  });
});

test('around an explanation opened by focus, the keyboard goes straight on', async ({ page }) => {
  await page.goto('/');
  const dialog = await openSettings(page, en.Harness.heading);
  await keyboardAround(page, dialog.locator('[data-term-hint="workStyle"]'), dialog);
  await pointerOutlastsFocus(page, dialog.locator('[data-term-hint="workStyle"]'));
  await page.keyboard.press('Escape');

  await importTeam(page, linearCorral(['writer']));
  const panel = await startTestRun(page);
  await keyboardAround(page, page.locator('[data-term-hint="execution"]'), panel);
  await pointerOutlastsFocus(page, page.locator('[data-term-hint="execution"]'));
});

test('no screen explains one term in two places', async ({ page }) => {
  await importTeam(page, linearCorral(['writer']));
  await startTestRun(page);
  await expect(page.getByRole('button', { name: about('execution'), exact: true })).toBeVisible();
  expect(await icons(page)).toEqual({ execution: 1 });

  await page.goto('/library/teams');
  await expect(page.getByRole('tab').first()).toBeVisible();
  expect(await icons(page)).toEqual({});

  await newConversationFromSidebar(page);
  await expect(page.locator('[data-slot="composer-advisor"]')).toBeVisible();
  expect(await icons(page)).toEqual({});

  await openSettings(page, en.Harness.heading);
  expect(await icons(page)).toEqual({ workStyle: 1 });
});
