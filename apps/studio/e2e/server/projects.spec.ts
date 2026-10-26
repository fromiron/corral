import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

// Projects against the local server: saved in the
// workspace database, so they survive reloads, and a run stays where it started.

function handle(page: Page, nodeId: string, port: string) {
  return page.locator(
    `.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${port}"]`,
  );
}

test('a run stays in the project it started in when its Corral moves', async ({ page, corral }) => {
  await corral.open('/projects');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Client A');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/project_[a-z0-9]+$/);
  const projectPath = new URL(page.url()).pathname;
  const projectId = projectPath.split('/').at(-1) ?? '';

  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.getByRole('button', { name: 'New team' }).click();
  await page.getByRole('button', { name: 'Add Agent' }).click();
  await page.getByRole('button', { name: 'Add Output' }).click();
  await handle(page, 'agent_1', 'out').dragTo(handle(page, 'output_1', 'in'));
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${projectPath}$`));
  const tab = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
  const runs = page.getByRole('region', { name: 'Runs' });
  await tab('Runs');
  await expect(runs.getByRole('listitem')).toHaveCount(1);

  // Move the Corral to the default project: it goes, its finished run stays.
  await tab('Teams');
  await page.getByRole('combobox', { name: 'Move Untitled team to another project' }).click();
  await page.getByRole('option', { name: 'My project', exact: true }).click();
  await expect(page.getByText('No teams yet.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Client A' })).toBeVisible();
  await tab('Runs');
  await expect(runs.getByRole('listitem')).toHaveCount(1);
  await page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: 'My project', exact: true })
    .click();
  await tab('Teams');
  await expect(page.getByRole('list', { name: 'Teams' }).getByRole('listitem')).toHaveCount(1);
  await tab('Runs');
  await expect(page.getByText('No runs yet.')).toBeVisible();

  // The run's own page shows the project it started in.
  await page.goto(`${corral.server.url}${projectPath}`);
  await tab('Runs');
  await runs.getByRole('link').first().click();
  await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(
    'Client A',
  );
  void projectId;
  expect(corral.errors).toEqual([]);
});
