import type { Locator } from '@playwright/test';
import { expect, test } from './harness.ts';

test.use({ live: true, reducedMotion: 'reduce' });

async function controlHeight(field: Locator) {
  return field.evaluate((element) => {
    const control = element.closest('[data-slot="input-control"]') ?? element;
    return control.getBoundingClientRect().height;
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`settings controls preserve keyboard editing and reflow in ${colorScheme}`, async ({
    page,
    corral,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await corral.open('/projects/default');
    await page.goto(`${corral.server.url}/projects/default?settings=general`);
    const language = page.getByRole('combobox', { name: 'Language', exact: true });
    await expect(language).toBeVisible();
    expect(await controlHeight(language)).toBe(36);

    await page.getByRole('link', { name: 'Settings vault', exact: true }).click();
    const project = page.getByRole('combobox', { name: 'Choose local project', exact: true });
    const team = page.getByRole('combobox', { name: 'Choose team for agents', exact: true });
    const bindings = page.getByRole('button', { name: 'Use these bindings', exact: true });
    await expect(bindings).toBeEnabled();
    for (const control of [project, team, bindings]) {
      await expect(control).toBeVisible();
    }
    await project.click();
    await page.getByRole('option', { name: 'My project', exact: true }).click();
    await bindings.click();
    await expect(project).toContainText('My project');

    await page.getByRole('link', { name: 'Models', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Import model settings' });
    const source = panel.getByRole('combobox', { name: 'Source', exact: true });
    const path = panel.getByLabel('Configuration file (optional)');
    const preview = panel.getByRole('button', { name: 'Preview settings', exact: true });
    await expect(path).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const control of [source, path, preview]) {
        await expect(control).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await source.focus();
    await page.keyboard.press('Tab');
    await expect(path).toBeFocused();
    expect(await path.evaluate((input) => input.matches(':focus-visible'))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'Claude Code', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(source).toBeFocused();

    await page.getByRole('link', { name: 'Work styles', exact: true }).click();
    const tools = page.getByRole('textbox', { name: 'Allowed tool names', exact: true });
    await expect(tools).toBeVisible();
    await tools.click();
    await page.keyboard.press('ArrowRight');
    await expect(tools).toBeFocused();
    await tools.fill('read_file, search');
    await page.getByRole('link', { name: 'Models', exact: true }).click();
    const guard = page.getByRole('dialog', { name: 'Unsaved settings' });
    await guard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(tools).toHaveValue('read_file, search');
    await page.emulateMedia({ forcedColors: 'active' });
    await tools.focus();
    // The kit draws focus on the visible control wrapper, not the inner textarea.
    const focusIndicator = tools.locator('..');
    await expect(focusIndicator).toHaveAttribute('data-slot', 'textarea-control');
    await expect(tools).toBeFocused();
    await expect(focusIndicator).toHaveCSS('outline-style', 'solid');
    expect(
      await focusIndicator.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).outlineWidth),
      ),
    ).toBeGreaterThan(0);
    expect(corral.errors).toEqual([]);
  });
}

test.describe('touch settings controls', () => {
  test.use({ hasTouch: true, deviceScaleFactor: 1.5, viewport: { width: 390, height: 844 } });
  test('standalone settings keep touch inputs and actions aligned', async ({ page, corral }) => {
    await corral.open('/settings/models');
    const panel = page.getByRole('region', { name: 'Import model settings' });
    for (const control of [
      panel.getByRole('combobox', { name: 'Source', exact: true }),
      panel.getByLabel('Configuration file (optional)'),
      panel.getByRole('button', { name: 'Preview settings', exact: true }),
    ]) {
      await expect(control).toBeVisible();
      expect(await controlHeight(control)).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    expect(corral.errors).toEqual([]);
  });
});

test('API key reveal controls keep a gap and the input height in both settings forms', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/models');
  const provider = page.getByTestId('provider-openai');
  const key = provider.getByLabel('API key', { exact: true });
  await expect(key).toBeVisible();
  const save = provider.getByRole('button', { name: 'Save key', exact: true });
  const checkPair = async (field: Locator, toggle: Locator) => {
    const input = await field.locator('..').boundingBox();
    const button = await toggle.boundingBox();
    if (!input || !button) throw new Error('Both key controls must be visible');
    expect.soft(Math.abs(button.height - input.height)).toBeLessThan(1);
    expect.soft(Math.abs(button.y - input.y)).toBeLessThan(1);
    expect.soft(button.x).toBeGreaterThan(input.x + input.width);
    await field.focus();
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
  };
  await checkPair(key, provider.getByRole('button', { name: 'Show API key', exact: true }));
  const input = await key.locator('..').boundingBox();
  const button = await save.boundingBox();
  if (!input || !button) throw new Error('The key field and save action must be visible');
  expect.soft(Math.abs(button.y - input.y)).toBeLessThan(1);
  expect.soft(Math.abs(button.height - input.height)).toBeLessThan(1);

  await page.getByRole('button', { name: 'Edit models', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Edit models', exact: true });
  await editor.getByRole('button', { name: 'Add endpoint', exact: true }).click();
  await editor.getByRole('combobox', { name: 'Access of endpoint 1', exact: true }).click();
  await page.getByRole('option', { name: 'API key', exact: true }).click();
  await checkPair(
    editor.getByLabel('API key', { exact: true }),
    editor.getByRole('button', { name: 'Show API key', exact: true }),
  );
  expect(corral.errors).toEqual([]);
});
