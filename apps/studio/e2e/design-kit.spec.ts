import { expect, test } from '@playwright/test';
import { requestBox } from './workbench.ts';

test('the kit themes preserve project creation and explicit theme choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    if (!localStorage.getItem('corral:workbench:v1'))
      localStorage.setItem('corral:workbench:v1', JSON.stringify({ version: 1, theme: 'light' }));
  });
  await page.goto('/projects');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 250, 250)');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Design kit');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Design kit', exact: true })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('corral:workbench:v1', JSON.stringify({ version: 1, theme: 'dark' }));
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 23, 23)');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('[data-slot="dialog-backdrop"]').first()).toHaveCSS(
    'background-color',
    /^(rgba\(0, 0, 0, 0\.8\)|oklab\(0 0 0 \/ 0\.8\))$/,
  );
});

test('narrow forms retain names, keyboard focus and reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.goto('/projects');
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeVisible();
  await name.focus();
  await page.keyboard.type('Keyboard project');
  const create = page.getByRole('button', { name: 'Create project', exact: true });
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press('Tab');
    if (await create.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(create).toBeFocused();
  const focus = await create.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
      duration: Math.max(...style.transitionDuration.split(',').map(Number.parseFloat)),
    };
  });
  expect(focus.visible).toBe(true);
  expect(focus.duration).toBeLessThanOrEqual(0.00001);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Keyboard project', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('described select choices stay separated and readable without losing a draft', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await requestBox(page).fill('Keep this draft');
  const picker = page.getByRole('combobox', { name: 'Permissions for next request', exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await picker.click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(4);
    await expect
      .poll(() =>
        options.evaluateAll((rows) =>
          rows.every((row, index) => {
            const box = row.getBoundingClientRect();
            const previous = rows[index - 1]?.getBoundingClientRect();
            return (
              (!previous || box.top > previous.bottom + 1) &&
              box.left >= 0 &&
              box.right <= window.innerWidth &&
              Array.from(row.querySelectorAll('span')).every((span) => {
                if (!span.textContent?.trim()) return true;
                const content = span.getBoundingClientRect();
                return content.top >= box.top - 1 && content.bottom <= box.bottom + 1;
              })
            );
          }),
        ),
      )
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`described-select-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(picker).toBeFocused();
  }
  await picker.press('Enter');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveText('Ask');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(requestBox(page)).toHaveValue('Keep this draft');
});
