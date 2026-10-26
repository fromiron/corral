import { expect, type Page } from '@playwright/test';

// Shared user-facing steps: start a chat directly, or explicitly choose a saved Corral.
// The team for the next turn is chosen from the composer's team chip.

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
  // without a choice a session starts in auto mode; this helper keeps the first team.
  await page.getByRole('combobox', { name: 'Corral', exact: true }).click();
  await page.getByRole('option').nth(1).click();
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
}

/** The request box (a combobox: it opens the `/` and `@` menus). */
export const requestBox = (page: Page) =>
  page.getByRole('combobox', { name: 'Request', exact: true });

/** Chooses the team for the next turn from the composer's team chip. */
export async function selectSessionTeam(page: Page, name: string) {
  const picker = page
    .getByRole('region', { name: 'Request', exact: true })
    .getByRole('combobox', { name: 'Team', exact: true });
  await picker.click();
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
  await expect(picker).toContainText(name);
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
