import { linearCorral } from '@corral/testkit';
import { expect, type Locator, type Page, test } from '@playwright/test';
import en from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import {
  importTeam,
  newConversationFromSidebar,
  openActivity,
  openSettings,
  requestBox,
  runControls,
  runGoing,
  startSession,
  startTestRun,
  teamFromTemplate,
} from './workbench.ts';

// Coined terms explain themselves where they stand as names (docs/specs/features/term-hints.md).
// Only what needs a real browser: a touch press on the icon and the line it stands on, the real
// keyboard around an open explanation, and the icons a whole screen draws.

const about = (term: keyof typeof en.Terms & string) =>
  en.Terms.about.replace('{term}', (en.Terms[term] as { name: string }).name);
const popup = (page: Page) => page.locator('[data-term-popup]');

// No step may leave an error on the page (a focus guard caught in a loop throws one each time).
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

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
  return stops;
}

/**
 * With the pointer resting on the icon, a Tab from an explanation opened by focus, or by a press,
 * still goes where it goes with the keyboard alone, stays there, and closes the explanation.
 */
async function tabWithPointerOnIcon(page: Page, icon: Locator, stops: Record<string, string>) {
  for (const how of ['focus', 'press'] as const) {
    if (how === 'focus') {
      await icon.focus();
      await expect(popup(page)).toBeVisible();
      await icon.hover();
    } else {
      await icon.click();
      await expect(popup(page)).toBeVisible();
    }
    await page.waitForTimeout(400);
    await page.keyboard.press('Tab');
    await expect(popup(page), `${how}: Tab with the pointer on the icon`).toHaveCount(0);
    expect(await focused(page), how).toBe(stops.Tab);
    await page.waitForTimeout(300);
    expect(await focused(page), `${how}, a moment later`).toBe(stops.Tab);
    await page.mouse.move(2, 2);
  }
}

/**
 * Opened by a press, it stays while the focus does, though the pointer leaves; the focus leaving
 * closes it, on to the same control as ever.
 */
async function pressOutlastsPointer(page: Page, icon: Locator, stops: Record<string, string>) {
  await icon.click();
  await expect(popup(page)).toBeVisible();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(600);
  await expect(popup(page), 'pressed open, the pointer gone').toBeVisible();
  await page.keyboard.press('Tab');
  await expect(popup(page), 'pressed open, the focus gone').toHaveCount(0);
  expect(await focused(page)).toBe(stops.Tab);
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
    const icon = dialog.getByRole('button', { name: about('harness'), exact: true });
    await icon.tap();
    await expect(popup(page)).toBeVisible();
    await expect(popup(page).locator('[data-term-meaning]')).toHaveText(en.Terms.harness.meaning);
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
    const icon = dialog.locator('[data-term-hint="harness"]');
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
  const settingsIcon = dialog.locator('[data-term-hint="harness"]');
  const settingsStops = await keyboardAround(page, settingsIcon, dialog);
  await tabWithPointerOnIcon(page, settingsIcon, settingsStops);
  await pressOutlastsPointer(page, settingsIcon, settingsStops);
  await page.keyboard.press('Escape');

  await importTeam(page, linearCorral(['writer']));
  const panel = await startTestRun(page);
  const treeIcon = page.locator('[data-term-hint="execution"]');
  const treeStops = await keyboardAround(page, treeIcon, panel);
  await tabWithPointerOnIcon(page, treeIcon, treeStops);
  await pressOutlastsPointer(page, treeIcon, treeStops);
});

test('no screen explains one term in two places', async ({ page }) => {
  await importTeam(page, linearCorral(['writer']));
  await startTestRun(page);
  await expect(page.getByRole('button', { name: about('execution'), exact: true })).toBeVisible();
  // The test run panel's Reins area has its title's icon (glossary.md).
  expect(await icons(page)).toEqual({ execution: 1, reins: 1 });

  await page.goto('/library/teams');
  await expect(page.getByRole('tab').first()).toBeVisible();
  expect(await icons(page)).toEqual({});

  await newConversationFromSidebar(page);
  await expect(page.locator('[data-slot="composer-advisor"]')).toBeVisible();
  expect(await icons(page)).toEqual({});

  await openSettings(page, en.Harness.heading);
  expect(await icons(page)).toEqual({ harness: 1 });
});

/**
 * The control row's box and the Pause and Stop buttons' boxes: nothing in the row moves when its
 * explanation opens or closes (features/term-hints.md).
 */
async function rowBoxes(row: Locator) {
  const box = async (locator: Locator) => {
    const b = await locator.boundingBox();
    return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
  };
  return {
    row: await box(row),
    pause: await box(row.getByRole('button', { name: en.Activity.pause, exact: true })),
    stop: await box(row.getByRole('button', { name: en.Activity.stop, exact: true })),
  };
}

test('the open activity panel names its control row Reins, explained once', async ({ page }) => {
  test.setTimeout(60_000);
  // Slow simulated replies keep the conversation's run going while it is looked at.
  await page.goto('/?delay=15000');
  await teamFromTemplate(page);
  await startSession(page, 'Reins in the activity panel');
  await requestBox(page).fill('Write a short note.');
  await requestBox(page).press('Control+Enter');
  await expect(runGoing(page)).toBeVisible({ timeout: 20_000 });
  await openActivity(page);
  const row = runControls(page);
  await expect(row).toBeVisible();
  await expect(row.getByText(en.Terms.reins.name, { exact: true })).toBeVisible();
  const icon = row.getByRole('button', { name: about('reins'), exact: true });
  await expect(icon).toBeVisible();
  expect((await icons(page)).reins).toBe(1);

  await page.mouse.move(2, 2);
  // The panel has finished folding out: the row stands still before it is measured.
  let closed = await rowBoxes(row);
  await expect
    .poll(async () => {
      const previous = closed;
      closed = await rowBoxes(row);
      return JSON.stringify(closed) === JSON.stringify(previous);
    })
    .toBe(true);
  expect(closed.pause && closed.stop).toBeTruthy();
  await icon.hover();
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).locator('[data-term-meaning]')).toHaveText(en.Terms.reins.meaning);
  expect(await rowBoxes(row), 'open').toEqual(closed);
  await page.mouse.move(2, 2);
  await expect(popup(page)).toHaveCount(0);
  expect(await rowBoxes(row), 'closed again').toEqual(closed);
  // The icon leaves the row as tall as the name and the buttons make it, where it stood.
  const line = await lineWithAndWithout(row.locator('[data-term-hint="reins"]'), row, row);
  expect(line.withIcon).toEqual(line.without);
});

test('the run record’s Reins area is titled Reins and its role, explained once', async ({
  page,
}) => {
  test.setTimeout(60_000);
  // Slow simulated replies keep an execution working while its Reins area is open.
  await page.goto('/demo?delay=8000');
  await startTestRun(page);
  await page.getByRole('link', { name: 'Open run page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_/);
  const monitor = page.getByTestId('run-monitor');
  await monitor
    .getByRole('group', { name: 'Run graph', exact: true })
    .locator('[data-agent-id]')
    .filter({ has: page.locator('[data-run-status="model"], [data-run-status="active"]') })
    .first()
    .getByRole('button')
    .first()
    .click();
  await page
    .locator('[data-slot="popover-popup"] li[data-execution-id]')
    .getByRole('button', { name: en.Run.steerThis, exact: true })
    .first()
    .click();
  const reins = monitor.getByTestId('run-instructions');
  await expect(reins).toBeVisible();
  // Opening the area still asks to type: the focus is in the instruction field.
  await expect(reins.getByLabel(en.Reins.instruction, { exact: true })).toBeFocused();
  const heading = reins.getByRole('heading', { level: 2, name: /^Reins · \S/ });
  await expect(heading).toBeVisible();
  const icon = reins.getByRole('button', { name: about('reins'), exact: true });
  await expect(icon).toBeVisible();
  // On the title's line, right after it.
  const title = await heading.boundingBox();
  const mark = await icon.boundingBox();
  if (!title || !mark) throw new Error('The title or its icon is not drawn');
  expect(mark.x).toBeGreaterThanOrEqual(title.x + title.width - 1);
  expect(Math.abs(mark.y + mark.height / 2 - (title.y + title.height / 2))).toBeLessThan(4);
  await icon.hover();
  await expect(popup(page).locator('[data-term-meaning]')).toHaveText(en.Terms.reins.meaning);
  expect((await icons(page)).reins).toBe(1);
});
