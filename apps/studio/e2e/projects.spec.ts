import { expect, type Page, test } from '@playwright/test';
import {
  chooseTeam,
  newTeam,
  openLibrary,
  openLibraryTeams,
  projectTab,
  savedTeams,
  startTestRun,
} from './workbench.ts';

// Projects in the in-browser runtime. Corrals
// live in this browser's storage; demo runs last until reload and follow their Corral here.
// Teams are kept per project in the library (library.md), which shows the project opened last.

const switcher = (page: Page) =>
  page.getByRole('banner').getByRole('button', { name: 'Go to project', exact: true });
/** Opens a project from the sidebar, where every active project is listed by name. */
const openProject = (page: Page, name: string) =>
  page.getByTestId('app-sidebar').getByRole('link', { name, exact: true }).first().click();

async function newProject(page: Page, name: string) {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/project_[a-z0-9]+$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

async function singleAgentRun(page: Page) {
  const project = page.url();
  const projectLocation = await page
    .getByRole('navigation', { name: 'Current location' })
    .innerText();
  await openLibrary(page, 'Templates');
  await page.getByRole('button', { name: 'Edit a copy of Single agent', exact: true }).click();
  await page.getByRole('button', { name: 'Save copy and edit' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await startTestRun(page);
  await expect(page.getByTestId('run-status')).toContainText('Completed', { timeout: 20_000 });
  await page.getByRole('link', { name: 'Open run page', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(
    projectLocation,
  );
  // Back through the run, the editor and the library to the project.
  for (let step = 0; step < 5 && page.url() !== project; step++) await page.goBack();
}

test('a project keeps its Corrals and runs apart, and / returns to it', async ({ page }) => {
  await page.goto('/?delay=50');
  // A cold dev server can take a while to serve the first page.
  await expect(page).toHaveURL(/\/projects\/default(\?.*)?$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'My project' })).toBeVisible();
  // The location's project item is the menu that changes projects, even with one project.
  await expect(switcher(page)).toContainText('My project');
  await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(
    'My project',
  );

  await newProject(page, 'Docs');
  const docs = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await singleAgentRun(page);
  await expect(page).toHaveURL(new RegExp(`/projects/${docs}`));
  await projectTab(page, 'Runs');
  await expect(page.getByRole('region', { name: 'Runs' }).getByRole('listitem')).toHaveCount(1);
  await openLibraryTeams(page, 'Docs');
  await expect(savedTeams(page)).toHaveCount(1);

  // The other project has neither.
  await openProject(page, 'My project');
  await expect(page).toHaveURL(/\/projects\/default$/);
  await projectTab(page, 'Runs');
  await expect(page.getByText('No runs yet.')).toBeVisible();
  await openLibraryTeams(page, 'My project');
  await expect(page.getByText('No Corrals yet', { exact: true })).toBeVisible();

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

  // The library shows the project opened last: the second.
  await openLibraryTeams(page);
  await newTeam(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/library\/teams$/);
  const detail = await chooseTeam(page, 'Untitled Corral');
  await detail.getByRole('button', { name: 'Move to…', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Same', exact: true }).click();
  await expect(savedTeams(page)).toHaveCount(0);
  await expect(page.getByText('No Corrals yet', { exact: true })).toBeVisible();
  await page.goto(`/projects/${first}`);
  await openLibraryTeams(page);
  await expect(savedTeams(page)).toHaveCount(1);

  // Archive the second: gone from the switcher, still listed on request, and restorable.
  await page.goto(`/projects/${second}`);
  await page.getByRole('button', { name: 'Actions for Same' }).click();
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('note')).toContainText('archived');
  await openLibraryTeams(page);
  await expect(page.getByRole('note')).toContainText('archived');
  await expect(page.getByRole('button', { name: 'New Corral' })).toBeHidden();
  await page.goto(`/projects/${first}`);
  await page.getByRole('button', { name: 'Hide the sidebar', exact: true }).click();
  await switcher(page).click();
  await expect(page.getByRole('menuitemradio', { name: 'Same' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Show archived (1)' }).click();
  await page.getByRole('button', { name: 'Restore: Same' }).click();
  // All projects names itself in the path; a project's path has the switcher.
  await expect(page.getByRole('button', { name: 'Archive: Same' })).toHaveCount(2);
  await page.goto(`/projects/${first}`);
  await switcher(page).click();
  await expect(page.getByRole('menuitemradio', { name: 'Same' })).toHaveCount(2);
});
