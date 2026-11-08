import { expect, test } from '@playwright/test';

test('a narrow editor opens on the whole team, and a rename in its settings saves', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/demo?delay=150');
  // The demo opens its guided test run; the editor alone is the narrow layout under test.
  await page.getByRole('button', { name: 'Close test run', exact: true }).click();
  const canvas = page.locator('[data-team-canvas]');
  await expect(canvas.locator('[data-node]')).toHaveCount(9, { timeout: 20_000 });
  await expect
    .poll(async () => {
      const bounds = await canvas.boundingBox();
      const nodes = await canvas.locator('[data-node]').all();
      if (!bounds) return false;
      for (const node of nodes) {
        const box = await node.boundingBox();
        if (
          !box ||
          box.x < bounds.x ||
          box.y < bounds.y ||
          box.x + box.width > bounds.x + bounds.width + 1 ||
          box.y + box.height > bounds.y + bounds.height + 1
        )
          return false;
      }
      return true;
    })
    .toBe(true);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Limits and criteria', exact: true }).click();
  const settings = page.getByRole('complementary', { name: 'Settings' });
  await settings.getByRole('textbox', { name: 'Name', exact: true }).fill('Narrow team');
  await expect(save).toBeEnabled();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Narrow team', level: 1 })).toBeVisible();
  await save.click();
  await expect(save).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('editor-768.png') });
});

test('test-run approvals stay inside the run panel at 768px', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/demo?delay=150');
  const panel = page.getByRole('complementary', { name: 'Test run' });
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  const approval = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' });
  await expect(approval).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => panel.evaluate((aside) => aside.scrollWidth <= aside.clientWidth + 1))
    .toBe(true);
  const continueButton = approval.getByRole('button', { name: 'Continue with this version' });
  await continueButton.scrollIntoViewIfNeeded();
  await expect(continueButton).toBeInViewport();
  await continueButton.click();
  const final = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Final output' });
  await expect(final).toBeVisible();
  await final.getByRole('button', { name: 'Confirm as final result' }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
});

test('call links are dashed and named in both themes', async ({ page }, testInfo) => {
  await page.goto('/demo?delay=150');
  const canvas = page.locator('[data-team-canvas]');
  const delegates = canvas.locator('[data-edge]').filter({ hasText: /^delegates$/ });
  // A cold dev server under parallel workers can take a while to serve the first page.
  await expect(delegates).toHaveCount(2, { timeout: 20_000 });
  await expect(canvas.locator('[data-edge]').filter({ hasText: /^asks$/ })).toHaveCount(1);
  const link = delegates.first();
  await expect(link.locator('path[stroke-dasharray]')).toHaveCount(1);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    // The name is drawn in a visible colour that differs from the canvas behind it.
    await expect
      .poll(() =>
        link.evaluate((group) => {
          const label = group.querySelector('text');
          const pane = group.closest('[data-team-canvas]');
          if (!label || !pane) return false;
          const fill = getComputedStyle(label).fill;
          let surface: Element | null = pane;
          let background = 'rgba(0, 0, 0, 0)';
          while (surface && background === 'rgba(0, 0, 0, 0)') {
            background = getComputedStyle(surface).backgroundColor;
            surface = surface.parentElement;
          }
          return fill !== 'none' && fill !== background;
        }),
      )
      .toBe(true);
    await canvas.screenshot({ path: testInfo.outputPath(`call-links-${colorScheme}.png`) });
  }
});
