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
