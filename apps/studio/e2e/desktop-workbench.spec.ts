import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { panelTab, requestBox, startSession, teamFromTemplate } from './workbench.ts';

async function openSession(page: Page, blank = false) {
  await page.goto('/?delay=50');
  await teamFromTemplate(page);
  if (blank) {
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);
    await expect(requestBox(page)).toHaveValue('');
    await expect(page.getByTestId('chat-timeline').getByRole('article')).toHaveCount(0);
  } else await startSession(page, 'Desktop workbench');
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
  await expect(navigation).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('[data-slot="dialog-backdrop"]')).toHaveCSS(
    'background-color',
    /^(?:oklab\(0 0 0 \/ 0\.4\)|rgba\(0, 0, 0, 0\.4\))$/,
  );
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

test('[TC-UX-004-H] DW-02/03 settings overlay keeps the same mounted work and draft', async ({
  page,
}) => {
  await openSession(page, true);
  const composer = page.getByTestId('chat-composer');
  const input = requestBox(page);
  await expect(composer).toBeVisible();
  await input.fill(
    Array.from({ length: 30 }, (_, i) => `Requirement ${i}: keep the conversation readable.`).join(
      '\n',
    ),
  );
  await input.press('Control+Enter');
  await expect(page.getByTestId('chat-timeline').getByText('Succeeded')).toBeVisible();
  await input.fill('Preserve this follow-up draft');
  await panelTab(page, 'Execution');
  const workUrl = page.url();
  const originalInput = await input.elementHandle();
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(4, 4));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(page).toHaveURL(/settings=general/);
  await expect(page.getByTestId('app-sidebar')).toHaveCount(1);
  expect(await originalInput?.evaluate((node) => node.isConnected)).toBe(true);
  await settings.getByRole('link', { name: 'Shortcuts', exact: true }).click();
  await settings.getByRole('link', { name: 'Back to work', exact: true }).click();
  expect(await originalInput?.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(4);
  await expect(page).toHaveURL(workUrl);
  await expect(page.getByRole('tab', { name: 'Execution', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(input).toHaveValue('Preserve this follow-up draft');
  expect(
    (await new AxeBuilder({ page }).analyze()).violations
      .filter((finding) => finding.impact === 'serious' || finding.impact === 'critical')
      .map((finding) => finding.id),
  ).toEqual([]);
  const before = await composer.boundingBox();
  await page.getByTestId('chat-timeline').evaluate((node) => {
    node.scrollTop = 0;
  });
  const after = await composer.boundingBox();
  expect(after?.y).toBe(before?.y);
  expect((after?.y ?? 0) + (after?.height ?? 0)).toBeLessThanOrEqual(800);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('tab', { name: 'Work panel', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Preserve this follow-up draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('[TC-UX-001-H] DW-05 a file opens in a remembered tab and its line reference enters the draft', async ({
  page,
}) => {
  const keyWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('same key')) keyWarnings.push(message.text());
  });
  await openSession(page);
  await page.getByRole('button', { name: 'Show the panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.getByText('Link a work folder to browse files.')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Folders & tools', exact: true }).click();
  await page.getByRole('button', { name: 'Link the example folder', exact: true }).click();
  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
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
  await expect(requestBox(page)).toHaveValue('Desktop workbench');
  await page.getByRole('button', { name: 'Reference lines', exact: true }).click();
  await expect(requestBox(page)).toHaveValue('@README.md:L1 Desktop workbench');
  await expect(page.getByRole('list', { name: 'References' })).toContainText('README.md:L1');
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
  const request = requestBox(page);
  await request.fill('@version');
  await expect(page.getByRole('listbox', { name: 'References' })).toBeVisible();
  await request.press('Enter');
  await expect(request).toHaveValue('@src/version.ts ');
  await request.fill('@src');
  await expect(page.getByRole('option', { name: /^src\/?$/ }).first()).toBeVisible();
  await expect(page.getByTestId('chat-timeline').getByRole('article')).toHaveCount(0);
  expect(keyWarnings).toEqual([]);
});
