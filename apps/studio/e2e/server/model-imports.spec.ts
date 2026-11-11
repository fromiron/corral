import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { modelSettingsTab } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, reasoningApi: true });

/** Settings › Models › Connections › Add connection → Import from another tool's settings. */
async function openImport(page: Page) {
  await modelSettingsTab(page, 'Connections');
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Close', exact: true }) });
  await dialog.getByRole('button', { name: /^Import from another tool/ }).click();
  await expect(dialog.getByRole('button', { name: 'Preview settings' })).toBeVisible();
  return dialog;
}

/** The kit's path field, by its accessible name. */
const pathField = (scope: Locator) =>
  scope.getByRole('textbox', { name: 'Configuration file (optional)', exact: true });

test('Settings imports selected models and keeps reasoning capability', async ({
  page,
  corral,
}) => {
  const path = join(corral.workspace, 'import-models.toml');
  writeFileSync(
    path,
    'model = "gpt-test-a"\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"',
  );
  await corral.open('/settings/models');
  const dialog = await openImport(page);
  await dialog
    .getByRole('tablist', { name: 'Source', exact: true })
    .getByRole('tab', { name: 'Codex', exact: true })
    .click();
  await pathField(dialog).fill(path);
  await dialog.getByRole('button', { name: 'Preview settings' }).click();
  await expect(dialog.getByRole('checkbox', { name: /openai \/ gpt-test-a/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import selected (0)' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /openai \/ gpt-test-a/ }).check();
  await dialog.getByRole('button', { name: 'Import selected (1)' }).click();
  await expect(dialog.getByRole('status')).toContainText('Settings saved and read back');
  // The typed path is still in the face, so leaving it asks first.
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const imported = (await modelSettingsTab(page, 'Profiles')).getByRole('button', {
    name: /^Model of import-[0-9a-f]+: /,
  });
  await expect(imported).toHaveAccessibleName(/: Test A$/);
  await page.reload();
  await expect(
    (await modelSettingsTab(page, 'Profiles')).getByRole('button', {
      name: /^Model of import-[0-9a-f]+: /,
    }),
  ).toHaveAccessibleName(/: Test A$/);
  // The models.dev catalog is under the Connections menu.
  await modelSettingsTab(page, 'Connections');
  await page.getByRole('button', { name: 'More connection actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'models.dev catalog', exact: true }).click();
  const catalog = page.getByRole('dialog', { name: 'models.dev catalog', exact: true });
  await expect(catalog.getByText('No cached catalog. Refresh to download metadata.')).toBeVisible();
  expect(corral.errors).toEqual([]);
});

test('unsupported configuration stays unselectable without leaking keys', async ({
  page,
  corral,
}) => {
  const path = join(corral.workspace, 'import-claude.json');
  const secret = 'fixture-oauth-never-visible';
  writeFileSync(
    path,
    JSON.stringify({
      model: 'claude-test',
      env: {
        ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example',
        ANTHROPIC_AUTH_TOKEN: secret,
      },
    }),
  );
  await corral.open('/settings/models');
  const dialog = await openImport(page);
  // Claude Code is the source the face starts on.
  await expect(
    dialog
      .getByRole('tablist', { name: 'Source', exact: true })
      .getByRole('tab', { name: 'Claude Code', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await pathField(dialog).fill(path);
  await dialog.getByRole('button', { name: 'Preview settings' }).click();
  await expect(dialog.getByRole('checkbox')).toBeDisabled();
  await expect(
    dialog.getByText('Custom Anthropic endpoints are not supported by this importer.'),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import selected (0)' })).toBeDisabled();
  expect(await page.content()).not.toContain(secret);
  expect(corral.errors).toEqual([]);
});
