import { expect, type Page, test } from '@playwright/test';

// Projects in the in-browser runtime. Corrals
// live in this browser's storage; demo runs last until reload and follow their Corral here.

const switcher = (page: Page) =>
  page.getByRole('banner').getByRole('button', { name: 'Go to project', exact: true });
const corralList = (page: Page) => page.getByRole('list', { name: 'Teams' });
const tab = (page: Page, name: 'Sessions' | 'Teams' | 'Project folder' | 'Runs') =>
  page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
/** Opens a project from the sidebar, where every active project is listed by name. */
const openProject = (page: Page, name: string) =>
  page.getByTestId('app-sidebar').getByRole('link', { name, exact: true }).first().click();

async function newProject(page: Page, name: string) {
  await page.goto('/projects');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/project_[a-z0-9]+$/);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
}

async function singleAgentRun(page: Page) {
  const projectLocation = await page
    .getByRole('navigation', { name: 'Current location' })
    .innerText();
  await tab(page, 'Teams');
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Edit this team' })
    .click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await page.getByRole('link', { name: 'Open execution page', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(
    projectLocation,
  );
  await page.goBack();
  await page.goBack();
}

test('a project keeps its Corrals and runs apart, and / returns to it', async ({ page }) => {
  await page.goto('/?delay=50');
  await expect(page).toHaveURL(/\/projects\/default(\?.*)?$/);
  await expect(page.getByRole('heading', { level: 2, name: 'My project' })).toBeVisible();
  await expect(switcher(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(
    'My project',
  );

  await newProject(page, 'Docs');
  const docs = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await singleAgentRun(page);
  await expect(page).toHaveURL(new RegExp(`/projects/${docs}`));
  await tab(page, 'Teams');
  await expect(corralList(page).getByRole('listitem')).toHaveCount(1);
  await tab(page, 'Runs');
  await expect(page.getByRole('region', { name: 'Runs' }).getByRole('listitem')).toHaveCount(1);

  // The other project has neither.
  await openProject(page, 'My project');
  await expect(page).toHaveURL(/\/projects\/default$/);
  await tab(page, 'Runs');
  await expect(page.getByText('No runs yet.')).toBeVisible();
  await tab(page, 'Teams');
  await expect(page.getByText('No teams yet.')).toBeVisible();

  // `/` opens the project worked in last.
  await openProject(page, 'Docs');
  await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText('Docs');
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`/projects/${docs}$`));
});

test('two projects may share a name; a Corral moves; an archived project is hidden', async ({
  page,
}) => {
  await newProject(page, 'Same');
  const first = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await newProject(page, 'Same');
  const second = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  expect(second).not.toBe(first);

  await tab(page, 'Teams');
  await page.getByRole('button', { name: 'New team' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${second}$`));
  await tab(page, 'Teams');
  await page.getByRole('combobox', { name: 'Move Untitled team to another project' }).click();
  await page.getByRole('option', { name: 'Same', exact: true }).click();
  await expect(corralList(page)).toHaveCount(0);
  await page.goto(`/projects/${first}`);
  await tab(page, 'Teams');
  await expect(corralList(page).getByRole('listitem')).toHaveCount(1);

  // Archive the second: gone from the switcher, still listed on request, and restorable.
  await page.goto(`/projects/${second}`);
  await page.getByRole('button', { name: 'Actions for Same' }).click();
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('note')).toContainText('archived');
  await tab(page, 'Teams');
  await expect(page.getByRole('button', { name: 'New team' })).toBeHidden();
  await page.goto(`/projects/${first}`);
  await page.getByRole('button', { name: 'Hide the sidebar', exact: true }).click();
  await switcher(page).click();
  await expect(page.getByRole('menuitemradio', { name: 'Same' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Show archived (1)' }).click();
  await page.getByRole('button', { name: 'Restore: Same' }).click();
  await switcher(page).click();
  await expect(page.getByRole('menuitemradio', { name: 'Same' })).toHaveCount(2);
});
