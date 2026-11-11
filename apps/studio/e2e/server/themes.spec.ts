import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

test.use({ reducedMotion: 'reduce' });

const NORD = 'rgb(46, 52, 64)';
const LIGHT = 'rgb(250, 250, 250)';

const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function chooseAppearance(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Appearance', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

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
  await expect(page.getByRole('combobox', { name: 'Appearance', exact: true })).toBeVisible();
  expect(await background(page)).toBe(LIGHT);
  const root = () =>
    page.evaluate(() => ({
      style: document.documentElement.getAttribute('style'),
      className: document.documentElement.className,
    }));
  const before = await root();
  expect(before.style).not.toContain('--surface-1');

  await chooseAppearance(page, 'Nord');
  await expect.poll(() => background(page)).toBe(NORD);
  await expect(page.getByRole('combobox', { name: 'Appearance', exact: true })).toHaveText('Nord');

  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Appearance', exact: true })).toHaveText('Nord');
  expect(await page.evaluate(() => (window as { firstAppFrame?: unknown }).firstAppFrame)).toEqual({
    surface: '#2e3440',
    dark: true,
    background: NORD,
  });

  await chooseAppearance(page, 'Light');
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
  const appearance = page.getByRole('combobox', { name: 'Appearance', exact: true });
  await expect(appearance).toHaveText('System');
  const themes = page.locator('[data-personal-themes]');

  await themes.getByRole('button', { name: 'New theme', exact: true }).click();
  const editor = page.locator('[data-theme-editor]');
  const name = editor.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeFocused();
  await name.fill('Harbor');
  await editor.getByRole('textbox', { name: 'Background', exact: true }).fill('#123456');
  // The draft is drawn across the app before anything is stored.
  await expect.poll(() => background(page)).toBe(HARBOR);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(editor).toHaveCount(0);
  await expect(themes.getByRole('listitem')).toHaveText(['Harbor']);
  await expect(appearance).toHaveText('Harbor');
  expect(await background(page)).toBe(HARBOR);

  await page.reload();
  await expect(appearance).toHaveText('Harbor');
  expect(await background(page)).toBe(HARBOR);

  const downloading = page.waitForEvent('download');
  await themes.getByRole('button', { name: 'Export Harbor', exact: true }).click();
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
  await expect(themes.getByRole('listitem')).toHaveText(['Harbor', 'Harbor (2)']);
  await expect(themes.getByRole('button', { name: 'Edit Harbor (2)', exact: true })).toBeFocused();
  // Importing adds the theme without applying it.
  await expect(appearance).toHaveText('Harbor');
  expect(await background(page)).toBe(HARBOR);
  expect(corral.errors).toEqual([]);
});
