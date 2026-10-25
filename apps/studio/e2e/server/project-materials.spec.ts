import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './harness.ts';

// CR-055 §6: the composer no longer attaches project instructions or memory to a request;
// they stay versioned project records.
test('[TC-ABS-009-H] clone and link through Projects; save versioned instructions', async ({
  page,
  corral,
}) => {
  test.setTimeout(60000);
  const source = join(corral.workspace, 'source-repo');
  const destination = join(corral.workspace, 'cloned-repo');
  mkdirSync(source);
  execFileSync('git', ['init', '-q'], { cwd: source });
  writeFileSync(join(source, 'README.md'), '# Project\n');
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'],
    { cwd: source },
  );

  await corral.open('/projects');
  await page.getByText('Clone Git repository', { exact: true }).click();
  await page.getByLabel('Repository URL', { exact: true }).fill(source);
  await page.getByLabel('Absolute path of new folder').fill(destination);
  await page.getByRole('button', { name: 'Start clone', exact: true }).click();
  await page
    .getByRole('button', { name: 'Use this folder', exact: true })
    .click({ timeout: 30000 });
  const create = page.getByRole('form', { name: 'New project' });
  await create.getByRole('textbox', { name: 'Name', exact: true }).fill('Absorption project');
  await create.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/project_/);
  const projectId = new URL(page.url()).pathname.split('/').at(-1);
  const binding = await page.request.get(
    `${corral.server.url}/api/v1/projects/${projectId}/workspace`,
  );
  expect((await binding.json()).binding.trusted).toBe(false);
  expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('# Project\n');

  await page.getByRole('tab', { name: 'Project folder', exact: true }).click();
  await page.getByRole('switch', { name: 'Trust this repository', exact: true }).click();
  await expect(
    page.getByRole('switch', { name: 'Trust this repository', exact: true }),
  ).toBeChecked();
  // Instructions and memory are project records, not folder files, so they have their own tab (#87).
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeHidden();
  await page.getByRole('tab', { name: 'Instructions & memory', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Project guide');
  await page
    .getByRole('textbox', { name: 'Contents', exact: true })
    .fill('Keep the original public API.');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project guide · v1', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Project guide · v1', exact: true })).toBeVisible();
});
