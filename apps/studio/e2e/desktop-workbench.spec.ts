import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

async function openSession(page: Page) {
  await page.goto('/?delay=50');
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Use this template' })
    .click();
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Purpose').fill('Desktop workbench');
  await page.getByRole('button', { name: 'Start session' }).click();
}

test('[TC-UX-001-H] DW-08 narrow navigation contains focus and Escape restores its trigger', async ({
  page,
}) => {
  await openSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole('button', { name: 'Show the sidebar', exact: true });
  await trigger.click();
  const navigation = page.getByRole('dialog');
  await expect(navigation).toBeVisible();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    await expect
      .poll(() =>
        navigation.evaluate((node) =>
          node.contains(document.activeElement) ? 'inside' : document.activeElement?.outerHTML,
        ),
      )
      .toBe('inside');
  }
  await page.keyboard.press('Escape');
  await expect(navigation).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('[TC-UX-001-H] DW-08 work, team design and settings fit the supported viewports', async ({
  page,
}) => {
  test.setTimeout(120000);
  await openSession(page);
  const session = page.url();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(session);
    for (const tab of ['Work', 'Team design']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const violations = (await new AxeBuilder({ page }).analyze()).violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }))).toEqual(
        [],
      );
    }
    await page.goto('/settings');
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (await new AxeBuilder({ page }).analyze()).violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);
  }
});

test('[TC-UX-001-H] DW-01/02 the app shell keeps navigation and theme across session and settings', async ({
  page,
}) => {
  await openSession(page);
  const sessionUrl = page.url();
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto(sessionUrl);
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('textbox', { name: 'Request', exact: true })).toBeVisible();
});

test('[TC-UX-001-H] DW-02/03 the composer stays docked while the conversation scrolls and drafts survive a tab change', async ({
  page,
}) => {
  await openSession(page);
  const composer = page.getByTestId('chat-composer');
  const input = page.getByRole('textbox', { name: 'Request', exact: true });
  await expect(composer).toBeVisible();
  await input.fill(
    Array.from({ length: 30 }, (_, i) => `Requirement ${i}: keep the conversation readable.`).join(
      '\n',
    ),
  );
  await input.press('Control+Enter');
  await expect(page.getByTestId('chat-timeline').getByText('Succeeded')).toBeVisible();
  await input.fill('Preserve this follow-up draft');
  await page.getByRole('tab', { name: 'Team design', exact: true }).click();
  await page.getByRole('tab', { name: 'Work', exact: true }).click();
  await expect(input).toHaveValue('Preserve this follow-up draft');
  const before = await composer.boundingBox();
  await page.getByTestId('chat-timeline').evaluate((node) => {
    node.scrollTop = 0;
  });
  const after = await composer.boundingBox();
  expect(after?.y).toBe(before?.y);
  expect((after?.y ?? 0) + (after?.height ?? 0)).toBeLessThanOrEqual(800);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[TC-UX-001-H] DW-05 a file opens in a remembered tab and its line reference enters the draft', async ({
  page,
}) => {
  await openSession(page);
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.getByText('Link a work folder to browse files.')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Work folder', exact: true }).click();
  await page.getByRole('button', { name: 'Link folder', exact: true }).click();
  await page.getByRole('link', { name: /^Desktop workbench/ }).click();
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Open README.md', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'File content', exact: true })
      .getByText('# Release notes', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reference lines', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Request', exact: true })).toHaveValue(
    '@README.md:L1 ',
  );
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Open src/version.ts', exact: true }).click();
  await page.getByRole('tab', { name: 'src/version.ts', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'README.md', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const request = page.getByRole('textbox', { name: 'Request', exact: true });
  await request.fill('@src/');
  await expect(page.getByRole('listbox', { name: 'File references' })).toBeVisible();
  await request.press('Enter');
  await expect(request).toHaveValue('@src/version.ts ');
  await expect(page.getByTestId('chat-timeline').getByRole('article')).toHaveCount(0);
});
