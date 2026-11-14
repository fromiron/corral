import type { Locator, Page } from '@playwright/test';
import { addConnection } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, reducedMotion: 'reduce' });

/** Settings › Models: another tool's settings are imported from a face of Add connection. */
async function openImport(page: Page) {
  const directory = await addConnection(page);
  await directory
    .getByRole('button', { name: 'Import from another tool’s settings', exact: true })
    .click();
  const face = page.getByRole('dialog', { name: 'Import settings', exact: true });
  await expect(face).toBeVisible();
  return face;
}

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
    const team = page.getByRole('combobox', { name: 'Choose Corral for agents', exact: true });
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
    const panel = await openImport(page);
    const sources = panel.getByRole('tablist', { name: 'Source', exact: true });
    const source = sources.getByRole('tab', { name: 'Claude Code', exact: true });
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
    // The sources are tabs: Shift+Tab returns to the chosen one and the arrows move along them.
    await page.keyboard.press('Shift+Tab');
    await expect(source).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const codex = sources.getByRole('tab', { name: 'Codex', exact: true });
    await expect(codex).toBeFocused();
    await expect(codex).toHaveAttribute('aria-selected', 'true');
    // Nothing typed: the dialog closes without asking.
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel).toBeHidden();

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
    const panel = await openImport(page);
    for (const control of [
      panel
        .getByRole('tablist', { name: 'Source', exact: true })
        .getByRole('tab', { name: 'Claude Code', exact: true }),
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
  const checkPair = async (field: Locator, toggle: Locator) => {
    await expect(field).toBeVisible();
    await expect(toggle).toBeVisible();
    // Both boxes from one frame: the dialog is centred, so it moves while its face settles.
    const [input, button] = await field.evaluate(
      (element, other) =>
        [element.parentElement, other].map((node) => {
          if (!node) return null;
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        }),
      await toggle.elementHandle(),
    );
    if (!input || !button) throw new Error('Both key controls must be visible');
    expect.soft(Math.abs(button.height - input.height)).toBeLessThan(1);
    expect.soft(Math.abs(button.y - input.y)).toBeLessThan(1);
    expect.soft(button.x).toBeGreaterThan(input.x + input.width);
    await field.focus();
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
  };
  // A provider's key, on its API key face of Add connection.
  const provider = await addConnection(page, 'OpenAI');
  await provider.getByRole('tab', { name: 'API key', exact: true }).click();
  await checkPair(
    provider.getByLabel('API key', { exact: true }),
    provider.getByRole('button', { name: 'Show API key', exact: true }),
  );
  await provider.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(provider).toBeHidden();

  // An OpenAI-compatible address's key, on the address face.
  const endpoint = await addConnection(page, 'OpenAI-compatible address');
  await expect(
    endpoint
      .getByRole('tablist', { name: 'Access', exact: true })
      .getByRole('tab', { name: 'API key', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await checkPair(
    endpoint.getByLabel('API key', { exact: true }),
    endpoint.getByRole('button', { name: 'Show API key', exact: true }),
  );
  expect(corral.errors).toEqual([]);
});
