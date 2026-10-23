import { expect, type Page } from '@playwright/test';

// Shared user-facing steps: start a chat directly, or explicitly choose a saved Corral.
// Advanced request controls are reached through Request options (CR-043).

/** On a project page: makes a Corral from a template and comes back to the project. */
export async function teamFromTemplate(page: Page, name = 'Single agent') {
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Edit this team' })
    .click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeVisible();
}

/** On a project page: starts a session with this purpose and its first team. */
export async function startSession(page: Page, purpose: string) {
  if (!(await page.getByRole('textbox', { name: 'Purpose' }).isVisible()))
    await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
  await page.getByRole('textbox', { name: 'Purpose' }).fill(purpose);
  // CR-024: without a choice a session starts in auto mode; this helper keeps the first team.
  await page.getByRole('combobox', { name: 'Corral', exact: true }).click();
  await page.getByRole('option').nth(1).click();
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
}

/** The request box (a combobox: it opens the `/` and `@` menus). */
export const requestBox = (page: Page) =>
  page.getByRole('combobox', { name: 'Request', exact: true });

/** Discloses the actual advanced controls, including keyboard-accessible nested menus. */
export async function openRequestOptions(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Request options', exact: true });
  if (!(await dialog.isVisible()))
    await page.getByRole('button', { name: 'Request options', exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Returns from advanced controls to the request without selecting or submitting anything. */
export async function closeRequestOptions(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Request options', exact: true });
  if (await dialog.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
}

/** Chooses an optional saved Corral through the same disclosure used by a person. */
export async function selectSessionTeam(page: Page, name: string) {
  const dialog = await openRequestOptions(page);
  const picker = dialog.getByRole('combobox', { name: 'Corral', exact: true });
  await picker.click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(picker).toContainText(name);
  await closeRequestOptions(page);
  if (name !== 'Default chat')
    await expect(
      page
        .getByRole('region', { name: 'Request', exact: true })
        .getByRole('button', { name, exact: true }),
    ).toBeVisible();
}

/** Runs a `/` command from the request box, keeping nothing else typed. */
export async function slash(page: Page, command: string) {
  const box = requestBox(page);
  await box.fill(`/${command}`);
  await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
  await box.press('Enter');
}

/** Opens a session pane by its tab, showing the side panes first when they are hidden. */
export async function panelTab(page: Page, name: string) {
  const show = page.getByRole('banner').getByRole('button', { name: 'Show the panel' });
  if (await show.isVisible()) await show.click();
  const tab = page.getByRole('tab', { name, exact: true });
  // A new layout opens only the conversation's linked panes; others open from an area's menu.
  if (!(await tab.count())) {
    await page.getByRole('button', { name: 'Open pane', exact: true }).first().click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
  await tab.click();
}
