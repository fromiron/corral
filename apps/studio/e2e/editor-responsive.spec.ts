import { expect, test } from '@playwright/test';

test('a narrow editor opens on the whole team and its tools can be collapsed without losing edits', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/demo?delay=150');
  const canvas = page.getByRole('application', { name: 'Corral canvas' });
  await expect(canvas.locator('.react-flow__node')).toHaveCount(9, { timeout: 20_000 });
  await expect
    .poll(async () => {
      const bounds = await canvas.boundingBox();
      const nodes = await canvas.locator('.react-flow__node').all();
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
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Narrow team');
  await expect(save).toBeEnabled();
  const previous = await canvas.boundingBox();
  const framing = await canvas.locator('.react-flow__viewport').getAttribute('style');
  await page.getByRole('button', { name: 'Hide team tools' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-inspector')).toBeHidden();
  await expect
    .poll(async () => (await canvas.boundingBox())?.width ?? 0)
    .toBeGreaterThan(previous?.width ?? 0);
  await expect(page.getByRole('button', { name: 'Show team tools' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(canvas.locator('.react-flow__viewport')).toHaveAttribute('style', framing ?? '');
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue(
    'Narrow team',
  );
  await save.click();
  await expect(save).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('editor-768.png') });
});

test('compact palette and active test-run controls remain within the inspector at 768px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/demo?delay=150');
  for (const kind of ['Agent', 'Decision', 'Loop', 'Output'])
    await expect(page.getByRole('button', { name: `Add ${kind}`, exact: true })).toBeInViewport();
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const approval = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' });
  await expect(approval).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () =>
      page
        .locator('.editor-inspector')
        .evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1),
    )
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

test('port names mask crossing links in both themes', async ({ page }, testInfo) => {
  await page.goto('/demo?delay=150');
  const canvas = page.getByRole('application', { name: 'Corral canvas' });
  const delegate = canvas
    .locator('.react-flow__node[data-id="research"] > span')
    .filter({ hasText: /^delegate$/ });
  await expect(delegate).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await expect
      .poll(() =>
        delegate.evaluate((label) => {
          const background = getComputedStyle(label).backgroundColor;
          return background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)';
        }),
      )
      .toBe(true);
    await canvas.screenshot({ path: testInfo.outputPath(`port-label-${colorScheme}.png`) });
  }
});
