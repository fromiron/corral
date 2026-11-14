import {
  addAgentAndOutput,
  chooseTeam,
  newTeam,
  openLibraryTeams,
  openProject,
  projectTab,
  savedTeams,
  startTestRun,
} from '../workbench.ts';
import { expect, test } from './harness.ts';

// Projects against the local server: saved in the
// workspace database, so they survive reloads, and a run stays where it started.

test('a run stays in the project it started in when its Corral moves', async ({ page, corral }) => {
  await corral.open('/projects');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Client A');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/project_[a-z0-9]+$/);
  const projectPath = new URL(page.url()).pathname;
  const projectId = projectPath.split('/').at(-1) ?? '';

  // Teams are kept per project in the library (library.md).
  await openLibraryTeams(page, 'Client A');
  await newTeam(page);
  await addAgentAndOutput(page);
  await startTestRun(page);
  await expect(page.getByTestId('run-status')).toContainText('Completed', { timeout: 15_000 });
  await openProject(page, 'Client A');
  await expect(page).toHaveURL(new RegExp(`${projectPath}$`));
  const runs = page.getByRole('region', { name: 'Runs' });
  await projectTab(page, 'Runs');
  await expect(runs.getByRole('listitem')).toHaveCount(1);

  // Move the Corral to the default project: it goes, its finished run stays.
  await openLibraryTeams(page, 'Client A');
  const detail = await chooseTeam(page, 'Untitled Corral');
  await detail.getByRole('button', { name: 'Move to…', exact: true }).click();
  await page.getByRole('menuitem', { name: 'My project', exact: true }).click();
  await expect(savedTeams(page)).toHaveCount(0);
  await expect(page.getByText('No Corrals yet', { exact: true })).toBeVisible();
  await page.goto(`${corral.server.url}${projectPath}`);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Client A' })).toBeVisible();
  await projectTab(page, 'Runs');
  await expect(runs.getByRole('listitem')).toHaveCount(1);
  await openLibraryTeams(page, 'My project');
  await expect(savedTeams(page)).toHaveCount(1);
  await openProject(page, 'My project');
  await projectTab(page, 'Runs');
  await expect(page.getByText('No runs yet.')).toBeVisible();

  // The run's own page shows the project it started in.
  await page.goto(`${corral.server.url}${projectPath}`);
  await projectTab(page, 'Runs');
  await runs.getByRole('link').first().click();
  await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(
    'Client A',
  );
  void projectId;
  expect(corral.errors).toEqual([]);
});
