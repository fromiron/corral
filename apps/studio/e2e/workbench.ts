import { expect, type Page } from '@playwright/test';

// Shared steps for the workbench after the polish plan (docs/plans/Workbench-Polish-Plan.md):
// templates live in the project's Teams tab, and a session starts from the box at the top.

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
  await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeVisible();
}

/** On a project page: starts a session with this purpose and its first team. */
export async function startSession(page: Page, purpose: string) {
  if (!(await page.getByRole('textbox', { name: 'Purpose' }).isVisible()))
    await page.getByText('Session details (optional)', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Purpose' }).fill(purpose);
  // CR-024: without a choice a session starts in auto mode; this helper keeps the first team.
  await page.getByRole('combobox', { name: 'Team', exact: true }).click();
  await page.getByRole('option').nth(1).click();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
}

/** The request box (a combobox: it opens the `/` and `@` menus). */
export const requestBox = (page: Page) => page.getByRole('combobox', { name: 'Request' });

/** Runs a `/` command from the request box, keeping nothing else typed. */
export async function slash(page: Page, command: string) {
  const box = requestBox(page);
  await box.fill(`/${command}`);
  await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
  await box.press('Enter');
}

/** Opens the session's side panel on a tab (it is closed until asked for). */
export async function panelTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true });
  if (!(await tab.isVisible()))
    await page.getByRole('banner').getByRole('button', { name: 'Show the panel' }).click();
  await tab.click();
}
