import { expect, test } from '@playwright/test';
import { newConversation, requestBox } from './workbench.ts';

test('saved details are shown again before a quick new conversation starts', async ({ page }) => {
  await page.goto('/');
  // Name and purpose are set in the header menu's dialog; closing it keeps them as a draft.
  await page.getByRole('button', { name: 'More ways to start a conversation' }).click();
  await page.getByRole('menuitem', { name: /^Set name, purpose and team first/ }).click();
  const details = page.getByRole('dialog', { name: 'New conversation', exact: true });
  await details.getByRole('textbox', { name: 'Session name' }).fill('Visible name');
  await details.getByRole('textbox', { name: 'Purpose' }).fill('Visible purpose');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  // The quick ways to start show the saved details first instead of starting with them.
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(details.getByRole('textbox', { name: 'Session name' })).toHaveValue('Visible name');
  await expect(details.getByRole('textbox', { name: 'Purpose' })).toHaveValue('Visible purpose');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: 'New conversation', exact: true })
    .click();
  await expect(details.getByRole('textbox', { name: 'Session name' })).toHaveValue('Visible name');
  await expect(page).not.toHaveURL(/\/sessions\//);
});

// workbench.md (세션 목록과 검색) says saved name, purpose and team are disclosed even while the
// details are folded away; they now live in a dialog and nothing outside it says they exist.
test.fixme('closed saved details still show that a name or purpose is saved', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'More ways to start a conversation' }).click();
  await page.getByRole('menuitem', { name: /^Set name, purpose and team first/ }).click();
  await page.getByRole('textbox', { name: 'Session name' }).fill('Visible name');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('main')).toContainText('Visible name');
});

test('archiving keeps the draft and explains that explicit sending keeps the archive', async ({
  page,
}) => {
  await page.goto('/');
  await newConversation(page);
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
  // The project's New conversation starts an empty session at once.
  await page.goto('/projects/default');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\//);
  await page.goto('/projects/default');
  // Empty sessions have their own group, collapsed until opened.
  const empty = page.getByRole('list', { name: 'Empty session', exact: true });
  await expect(empty).toBeHidden();
  await page.locator('summary', { hasText: 'Empty session' }).click();
  await empty.getByRole('button', { name: /Archive empty session/ }).click();
  await expect(page.getByRole('button', { name: /Archive empty session/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Show archived/ }).click();
  // The archived row is the one that can be restored; it repeats no state word.
  await expect(empty.getByRole('button', { name: /^Restore session: / })).toBeVisible();
});

test('sidebar session links remain keyboard reachable and row menu returns focus', async ({
  page,
}) => {
  await page.goto('/');
  await newConversation(page);
  const firstUrl = page.url();
  await page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: 'New conversation', exact: true })
    .click();
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
  await sidebar.getByRole('link', { name: 'New conversation', exact: true }).hover();
  await expect(page.getByRole('tooltip', { name: /^New conversation/ })).toBeVisible();
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
