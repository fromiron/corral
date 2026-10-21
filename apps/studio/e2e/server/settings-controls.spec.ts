import type { Locator } from '@playwright/test';
import { expect, test } from './harness.ts';

test.use({ live: true });

async function appearance(field: Locator) {
  return field.evaluate((element) => {
    const control = element.closest('[data-slot="input-control"]') ?? element;
    const style = getComputedStyle(control);
    return {
      height: control.getBoundingClientRect().height,
      border: style.borderTopColor,
      width: style.borderTopWidth,
      radius: style.borderTopLeftRadius,
      shadow: style.boxShadow,
      background: style.backgroundColor,
    };
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`[TC-UX-007-H] settings controls share quiet borders and aligned heights in ${colorScheme}`, async ({
    page,
    corral,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await corral.open('/projects/default');
    await page.goto(`${corral.server.url}/projects/default?settings=general`);
    const language = page.getByRole('combobox', { name: 'Language', exact: true });
    await expect(language).toBeVisible();
    const baseline = await appearance(language);
    expect(baseline.height).toBe(36);
    expect(baseline.width).toBe('1px');
    await page.screenshot({ path: test.info().outputPath(`general-${colorScheme}.png`) });

    await page.getByRole('link', { name: 'Settings vault', exact: true }).click();
    const project = page.getByRole('combobox', { name: 'Choose local project', exact: true });
    const team = page.getByRole('combobox', { name: 'Choose team for agents', exact: true });
    const bindings = page.getByRole('button', { name: 'Use these bindings', exact: true });
    await expect(bindings).toBeEnabled();
    for (const control of [project, team, bindings]) {
      expect.soft(await appearance(control)).toMatchObject({
        height: baseline.height,
        border: baseline.border,
        radius: baseline.radius,
      });
    }
    await page.screenshot({ path: test.info().outputPath(`vault-${colorScheme}.png`) });
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
    expect.soft((await appearance(path)).background).toBe((await appearance(source)).background);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const control of [source, path, preview]) {
        expect.soft(await appearance(control)).toMatchObject({
          height: baseline.height,
          border: baseline.border,
          radius: baseline.radius,
        });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel.screenshot({ path: test.info().outputPath(`model-import-${colorScheme}.png`) });
    await source.focus();
    await page.keyboard.press('Tab');
    await expect(path).toBeFocused();
    const focused = await appearance(path);
    expect(focused.border).not.toBe(baseline.border);
    expect(focused.shadow).not.toBe('none');
    expect(focused.height).toBe(baseline.height);
    await panel.screenshot({
      path: test.info().outputPath(`model-import-focus-${colorScheme}.png`),
    });
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'Claude Code', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(source).toBeFocused();

    await page.getByRole('link', { name: 'Work styles', exact: true }).click();
    const tools = page.getByRole('textbox', { name: 'Allowed tool names', exact: true });
    await expect(tools).toBeVisible();
    expect(await appearance(tools)).toMatchObject({
      border: baseline.border,
      radius: baseline.radius,
    });
    expect((await appearance(tools)).height).toBeGreaterThan(baseline.height);
    await tools.click();
    await page.keyboard.press('ArrowRight');
    await expect(tools).toBeFocused();
    await expect.poll(async () => (await appearance(tools)).border).not.toBe(baseline.border);
    await page.screenshot({ path: test.info().outputPath(`harness-focus-${colorScheme}.png`) });
    await tools.fill('read_file, search');
    await page.getByRole('link', { name: 'Models', exact: true }).click();
    const guard = page.getByRole('dialog', { name: 'Unsaved settings' });
    await guard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(tools).toHaveValue('read_file, search');
    await page.emulateMedia({ forcedColors: 'active' });
    await tools.focus();
    await expect(tools).toHaveCSS('outline-style', 'solid');
    expect(corral.errors).toEqual([]);
  });
}

test.describe('touch settings controls', () => {
  test.use({ hasTouch: true, deviceScaleFactor: 1.5, viewport: { width: 390, height: 844 } });
  test('[TC-UX-007-H] standalone settings keep touch inputs and actions aligned', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    const panel = page.getByRole('region', { name: 'Import model settings' });
    const inputBackground = (await appearance(panel.getByLabel('Configuration file (optional)')))
      .background;
    for (const control of [
      panel.getByRole('combobox', { name: 'Source', exact: true }),
      panel.getByLabel('Configuration file (optional)'),
      panel.getByRole('button', { name: 'Preview settings', exact: true }),
    ]) {
      await expect(control).toBeVisible();
      expect((await appearance(control)).height).toBe(44);
    }
    expect(
      (await appearance(panel.getByRole('combobox', { name: 'Source', exact: true }))).background,
    ).toBe(inputBackground);
    await panel.screenshot({ path: test.info().outputPath('model-import-touch.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    expect(corral.errors).toEqual([]);
  });
});

test('[TC-UX-007-N] API key reveal controls keep a gap and the input height in both settings forms', async ({
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
    expect.soft(button.height).toBe(input.height);
    expect.soft(button.y).toBe(input.y);
    expect.soft(button.x - (input.x + input.width)).toBeGreaterThanOrEqual(8);
    await field.focus();
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
  };
  await checkPair(key, provider.getByRole('button', { name: 'Show API key', exact: true }));
  const input = await key.locator('..').boundingBox();
  const button = await save.boundingBox();
  expect.soft(button?.y).toBe(input?.y);
  expect.soft(button?.height).toBe(input?.height);

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
