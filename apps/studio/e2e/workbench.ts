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
  await page.getByRole('button', { name: 'Save copy and edit' }).click();
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

/** The mounted request box; hidden views are included for draft-preservation assertions. */
export const requestBox = (page: Page) =>
  page.getByRole('combobox', { name: 'Request', exact: true, includeHidden: true });

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

/** Opens an existing session view, or its contextual file pane through the command palette. */
export async function panelTab(page: Page, name: string) {
  const views = page.getByRole('tablist', { name: 'Session views', exact: true });
  await expect(views).toBeVisible();
  const primary = name === 'Run' ? 'Execution history' : name;
  if (['Conversation', 'Execution history', 'Changes'].includes(primary)) {
    const tab = views.getByRole('tab', { name: primary, exact: true });
    if (primary !== 'Changes' || (await tab.count())) {
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      return;
    }
  }
  // File work may not have a primary tab until first opened. The palette is always reachable.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox', { name: 'Search commands' }).fill(`Open ${name}`);
  await palette
    .getByRole('option')
    .filter({ has: page.getByText(`Open ${name}`, { exact: true }) })
    .click();
}
