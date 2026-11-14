import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

test.use({ reducedMotion: 'reduce' });

const NORD = 'rgb(46, 52, 64)';
const LIGHT = 'rgb(250, 250, 250)';

const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** The appearance gallery: one radio group of theme cards. */
const gallery = (page: Page) => page.getByRole('radiogroup', { name: 'Appearance', exact: true });
const card = (page: Page, name: string) => gallery(page).getByRole('radio', { name, exact: true });
/** The personal themes' cards, by name. */
const personalNames = (page: Page) =>
  page
    .locator('[data-personal-themes]')
    .getByRole('radio')
    .evaluateAll((cards) => cards.map((each) => each.getAttribute('aria-label')));

test('a built-in theme applies at once, is in place on the first app frame after a reload, and light brings the default back', async ({
  page,
  corral,
}) => {
  // Records the root at the moment the app first puts its own content in #root, before that
  // frame is painted (observer callbacks run before rendering).
  await page.addInitScript(() => {
    const record = () => {
      const root = document.getElementById('root');
      const content = root?.firstElementChild;
      if (!content || content.getAttribute('role') === 'status') return false;
      Object.assign(window, {
        firstAppFrame: {
          surface: document.documentElement.style.getPropertyValue('--surface-1'),
          dark: document.documentElement.classList.contains('dark'),
          background: getComputedStyle(document.body).backgroundColor,
        },
      });
      return true;
    };
    const observer = new MutationObserver(() => {
      if (record()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });

  await corral.open('/projects/default');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(`${corral.server.url}/projects/default?settings=general`);
  await expect(gallery(page)).toBeVisible();
  expect(await background(page)).toBe(LIGHT);
  const root = () =>
    page.evaluate(() => ({
      style: document.documentElement.getAttribute('style'),
      className: document.documentElement.className,
    }));
  const before = await root();
  expect(before.style).not.toContain('--surface-1');

  await card(page, 'Nord').click();
  await expect.poll(() => background(page)).toBe(NORD);
  await expect(card(page, 'Nord')).toHaveAttribute('aria-checked', 'true');

  await page.reload();
  await expect(card(page, 'Nord')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (window as { firstAppFrame?: unknown }).firstAppFrame)).toEqual({
    surface: '#2e3440',
    dark: true,
    background: NORD,
  });

  // The keys move and choose: Home goes to System, and the next card is Light.
  await card(page, 'Nord').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Light')).toBeFocused();
  await expect(card(page, 'Light')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => background(page)).toBe(LIGHT);
  // Nothing the theme wrote is left on the root.
  expect(await root()).toEqual(before);
});

test('a new personal theme is saved and applied, stays after a reload, and its exported file imports as a second theme', async ({
  page,
  corral,
}, testInfo) => {
  const HARBOR = 'rgb(18, 52, 86)';
  await corral.open('/projects/default');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(`${corral.server.url}/projects/default?settings=general`);
  const checked = gallery(page).getByRole('radio', { checked: true });
  await expect(checked).toHaveAccessibleName('System');
  const themes = page.locator('[data-personal-themes]');

  const newTheme = themes.getByRole('button', { name: 'New theme', exact: true });
  await newTheme.click();
  const editor = page.locator('[data-theme-editor]');
  const name = editor.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeFocused();
  await name.fill('Harbor');
  // A color is a tile that opens the kit picker; a typed #rrggbb applies there.
  await editor.getByRole('button', { name: 'Background', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Background', exact: true });
  await picker.getByRole('textbox', { name: 'Hex value', exact: true }).fill('123456');
  // The draft is drawn across the app before anything is stored.
  await expect.poll(() => background(page)).toBe(HARBOR);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(editor).toHaveCount(1);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(editor).toHaveCount(0);
  await expect.poll(() => personalNames(page)).toEqual(['Harbor']);
  await expect(checked).toHaveAccessibleName('Harbor');
  // Focus is back on the tile that opened the editor.
  await expect(newTheme).toBeFocused();
  expect(await background(page)).toBe(HARBOR);

  await page.reload();
  await expect(checked).toHaveAccessibleName('Harbor');
  expect(await background(page)).toBe(HARBOR);

  const downloading = page.waitForEvent('download');
  await themes.getByRole('button', { name: 'Actions for Harbor', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Harbor.json');
  const file = testInfo.outputPath('Harbor.json');
  await download.saveAs(file);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
    name: 'Harbor',
    base: 'light',
    ui: { background: '#123456' },
  });

  const choosing = page.waitForEvent('filechooser');
  await themes.getByRole('button', { name: 'Import', exact: true }).click();
  await (await choosing).setFiles(file);
  await expect.poll(() => personalNames(page)).toEqual(['Harbor', 'Harbor (2)']);
  await expect(card(page, 'Harbor (2)')).toBeFocused();
  // Importing adds the theme without applying it.
  await expect(checked).toHaveAccessibleName('Harbor');
  expect(await background(page)).toBe(HARBOR);
  expect(corral.errors).toEqual([]);
});
