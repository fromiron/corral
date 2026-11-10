import type { Locator } from '@playwright/test';
import {
  openConversationDetails,
  openLibraryTeams,
  openProject,
  openSessionSearch,
} from '../workbench.ts';
import { expect, test } from './harness.ts';

// Measure rendered affordances, including alpha-composited borders and kit focus rings.
async function boundaryContrast(field: Locator) {
  return field.evaluate((input) => {
    const control =
      input.closest('[data-slot="input-control"], [data-slot="textarea-control"]') ??
      input.parentElement;
    if (!control) throw new Error('A field control is required');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('A color sampler is required');
    ctx.fillStyle = 'Canvas';
    ctx.fillRect(0, 0, 1, 1);
    const ancestors: Element[] = [];
    for (let node = control.parentElement; node; node = node.parentElement) ancestors.unshift(node);
    for (const node of ancestors) {
      ctx.fillStyle = getComputedStyle(node).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
    }
    const adjacent = [...ctx.getImageData(0, 0, 1, 1).data];
    const luminance = (channels: number[]) =>
      channels.slice(0, 3).reduce((sum, channel, index) => {
        const value = channel / 255;
        return (
          sum +
          (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
            ([0.2126, 0.7152, 0.0722][index] ?? 0)
        );
      }, 0);
    const backdrop = luminance(adjacent);
    const cues = [getComputedStyle(control).backgroundColor];
    for (const node of [control, input]) {
      const style = getComputedStyle(node);
      if (Number.parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none')
        cues.push(style.borderTopColor);
      if (Number.parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none')
        cues.push(style.outlineColor);
      for (const shadow of style.boxShadow.split(/,(?![^()]*\))/)) {
        const color = shadow.match(/(?:rgba?|color|oklch|oklab|lab|lch)\([^)]*\)/)?.[0];
        const geometry = color ? shadow.replace(color, '') : '';
        if (
          color &&
          (geometry.match(/-?[\d.]+px/g) ?? []).some((length) => Number.parseFloat(length) !== 0)
        )
          cues.push(color);
      }
    }
    return Math.max(
      ...cues.map((color) => {
        ctx.fillStyle = `rgb(${adjacent.slice(0, 3).join(' ')})`;
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const value = luminance([...ctx.getImageData(0, 0, 1, 1).data]);
        return (Math.max(value, backdrop) + 0.05) / (Math.min(value, backdrop) + 0.05);
      }),
    );
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`labeled inputs retain quiet boundaries and clear focus in ${colorScheme}`, async ({
    page,
    corral,
  }) => {
    await page.emulateMedia({ colorScheme });
    await corral.open('/projects/default');
    const details = await openConversationDetails(page);
    const name = details.getByRole('textbox', { name: 'Name', exact: true });
    for (const field of [name, details.getByRole('textbox', { name: 'Purpose', exact: true })]) {
      await expect(field).toBeVisible();
      await expect.poll(() => boundaryContrast(field)).toBeGreaterThan(1);
      await field.focus();
      // Resting bounds may be quiet; keyboard focus must remain a strong visible cue.
      await expect.poll(() => boundaryContrast(field)).toBeGreaterThanOrEqual(3);
    }
    await details.getByRole('combobox', { name: 'Corral', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(name).toBeFocused();
    expect(await name.evaluate((input) => input.matches(':focus-visible'))).toBe(true);
    await expect.poll(() => boundaryContrast(name)).toBeGreaterThanOrEqual(3);
    expect(corral.errors).toEqual([]);
  });
}

test.describe('model identification', () => {
  test.use({ live: true, codexLogin: true, reasoningApi: true });
  for (const locale of ['en', 'ko']) {
    test(`model and effort stay readable at 320/390px in ${locale}`, async ({ page, corral }) => {
      await page.addInitScript((value) => localStorage.setItem('corral:locale', value), locale);
      await page.route('**/api/v1/model-profiles', async (route) => {
        const response = await route.fetch();
        const profiles = await response.json();
        await route.fulfill({
          response,
          json: profiles.map((profile: { modelName: string }) => ({
            ...profile,
            modelName:
              locale === 'ko'
                ? '긴 모델 이름 검증 · reasoning-model-with-a-long-name-2026-10'
                : 'Long model name verification · reasoning-model-with-a-long-name-2026-10',
          })),
        });
      });
      await corral.open('/projects/default');
      await page
        .getByRole('button', {
          name: locale === 'en' ? 'New conversation' : '새 대화',
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/\/sessions\/session_/);
      // Ultra and the request options are gone; the model chip carries the choice.
      const box = page.getByRole('combobox', {
        name: locale === 'en' ? 'Request' : '요청',
        exact: true,
      });
      await box.fill('Keep this unsent draft.');
      const model = page.getByRole('button', {
        name: locale === 'en' ? 'Model' : '모델',
        exact: true,
      });
      await expect(model).toContainText('OpenAI');
      const settings = page.getByRole('dialog', {
        name: locale === 'en' ? 'Model settings' : '모델 설정',
        exact: true,
      });
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(model).toBeInViewport();
        const clipped = await model.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          return [...button.querySelectorAll('span')]
            .filter((span) => {
              if (span.children.length) return false;
              const range = document.createRange();
              range.selectNodeContents(span);
              return [...range.getClientRects()].some(
                (rect) =>
                  rect.left < bounds.left - 1 ||
                  rect.right > bounds.right + 1 ||
                  rect.top < bounds.top - 1 ||
                  rect.bottom > bounds.bottom + 1,
              );
            })
            .map((span) => span.textContent);
        });
        // Product gap: the kit's model chip truncates the name, which workbench.md forbids on
        // narrow screens. Soft, so the popup checks below still run.
        expect.soft(clipped).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await model.click();
        // The chip opens the model settings popup, whose models are a listbox.
        await expect(settings.getByRole('option').first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page.keyboard.press('Escape');
        await expect(model).toBeFocused();
        await expect(box).toHaveValue('Keep this unsent draft.');
      }
      await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
      await model.click();
      await expect(settings).toHaveCSS('outline-style', 'solid');
      expect(
        await settings.evaluate((el) => Number.parseFloat(getComputedStyle(el).outlineWidth)),
      ).toBeGreaterThan(0);
      await page.keyboard.press('Escape');
      await expect(model).toBeFocused();
      expect(corral.server.coordinator.listRuns()).toHaveLength(0);
      expect(corral.errors).toEqual([]);
    });
  }
});

test('list filtering is named separately from private text search', async ({ page, corral }) => {
  await corral.open('/projects/default');
  // The sidebar's search field finds sessions by title and purpose in the palette; the search of
  // message and result text is its own entry at the end of the list.
  const { palette, input } = await openSessionSearch(page);
  await input.fill('no-match-for-this-filter');
  const textSearch = palette.getByRole('option', {
    name: 'Search messages and results for “no-match-for-this-filter”',
    exact: true,
  });
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(textSearch).toBeVisible();
  await textSearch.click();
  const dialog = page.getByRole('dialog', { name: 'Search sessions and results', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Search text' })).toHaveValue(
    'no-match-for-this-filter',
  );
  await expect(
    dialog.getByRole('switch', { name: 'Include private messages and results' }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole('switch', { name: 'Include archived', exact: true }),
  ).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // #92: one entry point. Enter in the same field opens the full search with what was typed.
  const again = await openSessionSearch(page);
  await again.input.fill('no-match-for-this-filter');
  await again.input.press('Enter');
  await expect(dialog.getByRole('textbox', { name: 'Search text' })).toHaveValue(
    'no-match-for-this-filter',
  );
  await page.keyboard.press('Escape');
});

test('import guidance is contextual and import cancellation or failure preserves the session draft', async ({
  page,
  corral,
}) => {
  await corral.open('/projects/default');
  const details = await openConversationDetails(page);
  await details
    .getByRole('textbox', { name: 'Purpose', exact: true })
    .fill('Keep my project draft.');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  // Teams are imported in the library. Its guidance is the import button's own description and
  // tooltip; the screen does not add an explanatory sentence (workbench.md 전역 셸과 화면 틀).
  await openLibraryTeams(page);
  const input = page.locator('input[type="file"][accept=".json,application/json"]');
  const importButton = page.getByRole('button', { name: 'Import JSON', exact: true });
  // Reached from the keyboard, as before: the tooltip follows visible focus.
  await importButton.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(importButton).toBeFocused();
  await expect(importButton).toHaveAccessibleDescription('Choose a .corral.json file.');
  await expect(page.getByRole('tooltip', { name: 'Choose a .corral.json file.' })).toBeVisible();
  const choosing = page.waitForEvent('filechooser');
  await importButton.press('Enter');
  await (await choosing).setFiles([]);
  await input.setInputFiles({
    name: 'invalid.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  // The new conversation's details keep the draft through the cancelled and failed imports.
  await openProject(page, 'My project');
  const again = await openConversationDetails(page);
  await expect(again.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue(
    'Keep my project draft.',
  );
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
});
