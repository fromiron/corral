import { expect, type Page, test } from '@playwright/test';

// Projects (CR-010, roadmap 22; proposal WBTST-001/003) in the in-browser runtime. Corrals
// live in this browser's storage; demo runs last until reload and follow their Corral here.

const switcher = (page: Page) => page.getByRole('banner').getByLabel('Project', { exact: true });
const corralList = (page: Page) => page.getByRole('list', { name: 'Corrals' });

async function newProject(page: Page, name: string) {
  await page.goto('/projects');
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/project_[a-z0-9]+$/);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
}

async function singleAgentRun(page: Page) {
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Use this template' })
    .click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20_000 });
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
}

test('[WBTST-001] a project keeps its Corrals and runs apart, and / returns to it', async ({
  page,
}) => {
  await page.goto('/?delay=50');
  await expect(page).toHaveURL(/\/projects\/default(\?.*)?$/);
  await expect(page.getByRole('heading', { level: 2, name: 'My project' })).toBeVisible();
  await expect(switcher(page)).toHaveValue('default');

  await newProject(page, 'Docs');
  const docs = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await singleAgentRun(page);
  await expect(page).toHaveURL(new RegExp(`/projects/${docs}$`));
  await expect(corralList(page).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Runs' }).getByRole('listitem')).toHaveCount(1);

  // The other project has neither.
  await switcher(page).selectOption('default');
  await expect(page).toHaveURL(/\/projects\/default$/);
  await expect(page.getByText('No Corrals yet.')).toBeVisible();
  await expect(page.getByText('No runs yet.')).toBeVisible();

  // `/` opens the project worked in last.
  await switcher(page).selectOption(docs);
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`/projects/${docs}$`));
});

test('[WBTST-001] two projects may share a name; a Corral moves; an archived project is hidden', async ({
  page,
}) => {
  await newProject(page, 'Same');
  const first = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await newProject(page, 'Same');
  const second = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  expect(second).not.toBe(first);

  await page.getByRole('button', { name: 'New Corral' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${second}$`));
  await page.getByLabel('Move Untitled Corral to another project').selectOption(first);
  await expect(corralList(page)).toHaveCount(0);
  await page.goto(`/projects/${first}`);
  await expect(corralList(page).getByRole('listitem')).toHaveCount(1);

  // Archive the second: gone from the switcher, still listed on request, and restorable.
  await page.goto(`/projects/${second}`);
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('note')).toContainText('archived');
  await expect(page.getByRole('button', { name: 'New Corral' })).toBeHidden();
  await page.goto(`/projects/${first}`);
  await expect(switcher(page)).toHaveValue(first);
  await expect(switcher(page).locator(`option[value="${second}"]`)).toHaveCount(0);
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Show archived (1)' }).click();
  await page.getByRole('button', { name: 'Restore: Same' }).click();
  await expect(switcher(page).locator(`option[value="${second}"]`)).toHaveCount(1);
});
