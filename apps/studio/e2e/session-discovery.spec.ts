import { expect, test } from '@playwright/test';
import { requestBox } from './workbench.ts';

test('collapsed saved details disclose their values before starting a session', async ({
  page,
}) => {
  await page.goto('/');
  const details = page.getByRole('button', { name: /^Session details/ });
  await details.click();
  await page.getByRole('textbox', { name: 'Session name' }).fill('Visible name');
  await page.getByRole('textbox', { name: 'Purpose' }).fill('Visible purpose');
  await details.click();
  await expect(details).toContainText('Visible name');
  await expect(details).toContainText('Saved details');
  await page.getByTestId('app-sidebar').locator('a[aria-label="New session"]').click();
  await expect(page.getByRole('textbox', { name: 'Session name' })).toHaveValue('Visible name');
  await expect(page).not.toHaveURL(/\/sessions\//);
});

test('archiving keeps the draft and explains that explicit sending keeps the archive', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await requestBox(page).fill('Unsent draft');
  await page
    .getByRole('banner')
    .getByRole('button', { name: /Actions for/ })
    .click();
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Sending a message keeps this session archived.')).toBeVisible();
  await expect(requestBox(page)).toHaveValue('Unsent draft');
  await page.getByRole('button', { name: 'Restore session', exact: true }).click();
  await expect(page.getByText('Sending a message keeps this session archived.')).toBeHidden();
  await expect(requestBox(page)).toHaveValue('Unsent draft');
});

test('project session list distinguishes and archives empty sessions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\//);
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Session status' }).click();
  await page.getByRole('option', { name: 'Empty session', exact: true }).click();
  await page.getByRole('button', { name: /Archive empty session/ }).click();
  await expect(page.getByRole('button', { name: /Archive empty session/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Show archived/ }).click();
  await expect(page.getByRole('list', { name: 'Sessions', exact: true })).toContainText('Archived');
});

test('sidebar session links remain keyboard reachable and row menu returns focus', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\//);
  const firstUrl = page.url();
  await page.getByTestId('app-sidebar').locator('a[aria-label="New session"]').click();
  await expect(page).not.toHaveURL(firstUrl);
  await expect(requestBox(page)).toBeVisible();
  await page.goto('/');
  const sidebar = page.getByTestId('app-sidebar');
  const sessionLink = sidebar.locator('a[href^="/sessions/"]').first();
  await expect(sessionLink).toHaveAttribute('tabindex', '0');
  await expect(sidebar.getByText('Use ↑ and ↓ to move between sessions.')).toBeVisible();
  const menu = sidebar.getByRole('button', { name: /Actions for/ }).first();
  await menu.click();
  await expect(page.getByRole('menuitem', { name: 'Rename session', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeFocused();
  await menu.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Rename session', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await sidebar.locator('a[aria-label="New session"]').hover();
  await expect(page.getByRole('tooltip', { name: /^New session/ })).toBeVisible();
  await page.mouse.move(700, 700);
  await sessionLink.focus();
  await sessionLink.press('ArrowDown');
  const nextSession = sidebar.locator('a[href^="/sessions/"]').nth(1);
  await expect(nextSession).toBeFocused();
  await nextSession.press('Enter');
  await expect(requestBox(page)).toBeVisible();
  const actions = page.getByRole('banner').getByRole('button', { name: /Actions for/ });
  await actions.focus();
  await expect(page.getByRole('tooltip', { name: /Actions for/ })).toBeVisible();
  const files = page.getByRole('button', { name: 'Open file viewer', exact: true });
  await files.focus();
  await expect(page.getByRole('tooltip', { name: /Open file viewer/ })).toBeVisible();
});
