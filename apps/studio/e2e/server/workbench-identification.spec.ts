import { expect, test } from './harness.ts';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`[TC-UX-007-H] labeled inputs retain quiet boundaries and clear focus in ${colorScheme}`, async ({
    page,
    corral,
  }) => {
    await page.emulateMedia({ colorScheme });
    await corral.open('/projects/default');
    await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
    const name = page.getByRole('textbox', { name: 'Session name', exact: true });
    for (const field of [name, page.getByRole('textbox', { name: 'Purpose', exact: true })]) {
      const restingBorder = await field.evaluate((input) => {
        const control = input.closest('[data-slot="input-control"]') ?? input;
        return getComputedStyle(control).borderTopColor;
      });
      expect(restingBorder).not.toBe('rgba(0, 0, 0, 0)');
      await field.focus();
      // CR-045 follow-up adopts subtle resting borders; the 3:1 cue belongs to focus.
      const contrast = await field.evaluate((input) => {
        const control = input.closest('[data-slot="input-control"]') ?? input;
        const style = getComputedStyle(control);
        let container = control.parentElement;
        while (container && getComputedStyle(container).backgroundColor === 'rgba(0, 0, 0, 0)')
          container = container.parentElement;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        if (!ctx || !container) throw new Error('A rendered field and color sampler are required');
        const luminance = (color: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, alpha] = ctx.getImageData(0, 0, 1, 1).data;
          if (alpha !== 255) return null;
          return [r ?? 0, g ?? 0, b ?? 0].reduce((sum, channel, index) => {
            const value = channel / 255;
            return (
              sum +
              (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
                ([0.2126, 0.7152, 0.0722][index] ?? 0)
            );
          }, 0);
        };
        const adjacent = luminance(getComputedStyle(container).backgroundColor);
        if (adjacent === null) throw new Error('The field must have an opaque adjacent surface');
        const cues = [style.backgroundColor];
        if (Number.parseFloat(style.borderTopWidth) > 0) cues.push(style.borderTopColor);
        if (Number.parseFloat(style.outlineWidth) > 0) cues.push(style.outlineColor);
        return Math.max(
          ...cues.map((color) => {
            const value = luminance(color);
            return value === null
              ? 1
              : (Math.max(value, adjacent) + 0.05) / (Math.min(value, adjacent) + 0.05);
          }),
        );
      });
      expect(contrast).toBeGreaterThanOrEqual(3);
    }
    await page.getByRole('combobox', { name: 'Corral', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(name).toBeFocused();
    expect(await name.evaluate((input) => input.matches(':focus-visible'))).toBe(true);
    await expect(name.locator('..')).not.toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
    expect(corral.errors).toEqual([]);
  });
}

test.describe('model identification', () => {
  test.use({ live: true, codexLogin: true, reasoningApi: true });
  for (const locale of ['en', 'ko']) {
    test(`[TC-UX-007-N] model and effort stay readable at 320/390px in ${locale}`, async ({
      page,
      corral,
    }) => {
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
        .getByRole('button', { name: locale === 'en' ? 'Start chat' : '대화 시작', exact: true })
        .click();
      // Ultra and the request options are gone (CR-055 §6); the model chip carries the choice.
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
        expect(clipped).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await model.click();
        await expect(page.getByRole('menuitemradio').first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page.keyboard.press('Escape');
        await expect(model).toBeFocused();
        await expect(box).toHaveValue('Keep this unsent draft.');
      }
      await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
      await model.click();
      await expect(page.getByRole('menu')).toHaveCSS('outline-style', 'solid');
      expect(
        await page
          .getByRole('menu')
          .evaluate((el) => Number.parseFloat(getComputedStyle(el).outlineWidth)),
      ).toBeGreaterThan(0);
      await page.keyboard.press('Escape');
      await expect(model).toBeFocused();
      expect(corral.server.coordinator.listRuns()).toHaveLength(0);
      expect(corral.errors).toEqual([]);
    });
  }
});

test('[TC-UX-007-H] list filtering is named separately from private text search', async ({
  page,
  corral,
}) => {
  await corral.open('/projects/default');
  const filter = page.getByRole('searchbox', { name: 'Filter conversations', exact: true });
  await expect(filter).toBeVisible();
  await filter.fill('no-match-for-this-filter');
  await expect(page.getByText('No matching sessions', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Search sessions and results', exact: true }).click();
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
  await expect(filter).toHaveValue('no-match-for-this-filter');
  // #92: one entry point. Full search starts from the same field: its trailing button sits
  // inside the field, and Enter in the field opens it with what was typed.
  const field = page.getByTestId('session-search-field');
  await expect(
    field.getByRole('button', { name: 'Search sessions and results', exact: true }),
  ).toBeVisible();
  await filter.press('Enter');
  await expect(dialog.getByRole('textbox', { name: 'Search text' })).toHaveValue(
    'no-match-for-this-filter',
  );
  await page.keyboard.press('Escape');
});

test('[TC-UX-007-N] import guidance is contextual and import cancellation or failure preserves the session draft', async ({
  page,
  corral,
}) => {
  await corral.open('/projects/default');
  await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
  await page.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Keep my project draft.');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await expect(
    page.getByText(
      'A custom Corral is optional. Use one when you want to define roles and how they work together.',
      { exact: true },
    ),
  ).toHaveCount(1);
  const input = page.locator('input[type="file"][accept=".json,application/json"]');
  const importButton = page.getByRole('button', { name: 'Import JSON', exact: true });
  await page.keyboard.press('Tab');
  await expect(importButton).toBeFocused();
  await expect(
    page.getByText('Choose a .corral.json file, optionally with its layout file.', { exact: true }),
  ).toBeVisible();
  const choosing = page.waitForEvent('filechooser');
  await importButton.press('Enter');
  await (await choosing).setFiles([]);
  await expect(page.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue(
    'Keep my project draft.',
  );
  await input.setInputFiles({
    name: 'invalid.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue(
    'Keep my project draft.',
  );
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
});
