import { linearCorral } from '@corral/testkit';
import { expect, type Page, test } from '@playwright/test';
import en from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import { importTeam, newConversationFromSidebar, openSettings, startTestRun } from './workbench.ts';

// Coined terms explain themselves where they stand as names (docs/specs/features/term-hints.md).
// Only what needs a real browser: a touch press on the icon, and the icons a whole screen draws.

const about = (term: keyof typeof en.Terms & string) =>
  en.Terms.about.replace('{term}', (en.Terms[term] as { name: string }).name);
const popup = (page: Page) => page.locator('[data-term-popup]');

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
