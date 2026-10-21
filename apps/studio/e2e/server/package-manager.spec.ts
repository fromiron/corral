import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './harness.ts';

const repositories: string[] = [];
test.afterEach(() => {
  for (const repository of repositories.splice(0))
    rmSync(repository, { recursive: true, force: true });
});

test('reviewed packages install untrusted, preserve plain text metadata, and keep disabled state', async ({
  page,
  corral,
}) => {
  test.setTimeout(90_000);
  const repository = mkdtempSync(join(tmpdir(), 'corral-package-project-'));
  repositories.push(repository);
  execFileSync('git', ['init', '-q', repository]);
  writeFileSync(join(repository, 'README.md'), '# Package project\n');
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'Initial',
    ],
    { cwd: repository },
  );
  const source = join(corral.workspace, 'package-ui-fixture');
  mkdirSync(source);
  const version = (number: string) => {
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'reviewed-ui-fixture',
        version: number,
        license: 'MIT',
        pi: { extensions: ['./extension.ts'] },
        corral: {
          version: 1,
          requestedCapabilities: ['read_file'],
          mcpServers: [
            {
              id: 'package_example',
              name: 'Example MCP',
              transport: 'http',
              url: 'http://127.0.0.1:19999/mcp',
            },
          ],
          ui: [
            {
              id: 'details',
              slot: 'package-details',
              title: 'Declared details',
              body: '<img src=x onerror=alert(1)>',
            },
          ],
        },
      }),
    );
  };
  version('1.0.0');
  writeFileSync(join(source, 'extension.ts'), 'export default () => {};');
  await corral.open('/');
  await page.getByRole('tab', { name: /^Project folder/ }).click();
  const folder = page.getByRole('tabpanel', { name: 'Project folder' });
  await folder.getByLabel('Folder path on this computer').fill(repository);
  await folder.getByRole('button', { name: 'Link folder' }).click();
  await expect(folder).toContainText('no uncommitted changes');
  const trust = folder.getByRole('checkbox', { name: /Trust this repository/ });
  await trust.click();
  await expect(trust).toBeChecked();
  await page.goto(`${corral.server.url}/settings/hooks?projectId=default`);
  const packages = page.getByRole('region', { name: 'Packages', exact: true });
  await packages.getByLabel('Package source', { exact: true }).fill(source);
  await packages.getByRole('button', { name: 'Review package', exact: true }).click();
  const review = packages.getByRole('region', { name: 'Reviewed copy', exact: true });
  await expect(review).toContainText('reviewed-ui-fixture', { timeout: 30_000 });
  await expect(review).toContainText('MIT');
  await expect(review).toContainText('read_file');
  await expect(review.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(review.locator('img')).toHaveCount(0);
  await review.getByRole('button', { name: 'Install reviewed copy', exact: true }).click();
  const installed = packages.getByRole('region', { name: 'Installed packages', exact: true });
  const item = installed.getByRole('listitem').filter({ hasText: 'reviewed-ui-fixture · 1.0.0' });
  await expect(item).toContainText('Not trusted');
  await item.getByText('Package details', { exact: true }).click();
  // Lose only the reply after the production endpoint commits registration.
  await page.route(
    '**/api/v1/harness/packages/*/mcp',
    async (route) => {
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBeTruthy();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await item.getByRole('button', { name: 'Register disabled', exact: true }).click();
  await expect(packages.getByRole('alert')).toBeVisible();
  await item.getByRole('button', { name: 'Register disabled', exact: true }).click();
  await expect(packages.getByRole('status')).toContainText('Registered as disabled');
  const tools = await page.request.get(
    new URL('/api/v1/harness/projects/default/tools', page.url()).href,
  );
  const config = await tools.json();
  expect(config.mcpServers).toHaveLength(1);
  expect(config.mcpServers[0]).toMatchObject({ enabled: false });
  await item.getByRole('button', { name: 'Trust this content', exact: true }).click();
  await expect(item.getByRole('button', { name: 'Revoke trust', exact: true })).toBeVisible();
  await item.getByRole('button', { name: 'Disable', exact: true }).click();
  await page.reload();
  await expect(item.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Revoke trust', exact: true })).toBeVisible();

  // A reviewed update is fixed even if the source folder changes before installation.
  version('1.1.0');
  await packages.getByLabel('Package source', { exact: true }).fill(source);
  await packages.getByRole('combobox', { name: 'Compare with', exact: true }).click();
  await page.getByRole('option', { name: 'reviewed-ui-fixture · 1.0.0', exact: true }).click();
  await packages.getByRole('button', { name: 'Review package', exact: true }).click();
  await expect(review).toContainText('Changed files', { timeout: 30_000 });
  version('9.9.9');
  await review.getByRole('button', { name: 'Install reviewed copy', exact: true }).click();
  await expect(installed).toContainText('reviewed-ui-fixture · 1.1.0');
  await expect(installed).not.toContainText('9.9.9');
  await expect(
    installed
      .getByRole('listitem')
      .filter({ hasText: 'reviewed-ui-fixture · 1.1.0' })
      .getByRole('button', { name: 'Trust this content', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(installed).toContainText('reviewed-ui-fixture · 1.1.0');
  const entries = await (
    await page.request.get(new URL('/api/v1/harness/entries', page.url()).href)
  ).json();
  const previous = entries.find(
    (entry: { resource: { version: string } }) => entry.resource.version === '1.0.0',
  );
  const upgraded = entries.find(
    (entry: { resource: { version: string } }) => entry.resource.version === '1.1.0',
  );
  expect(previous.successor).toMatchObject({
    resourceHash: upgraded.resourceHash,
    entry: upgraded.entry,
  });
  await item.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(item.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  await page.reload();
  await item.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(item.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Revoke trust', exact: true })).toBeVisible();
});
