import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './harness.ts';

test.use({ live: true, reasoningApi: true });

test('[TC-ABS-005-H] Settings imports selected models and keeps reasoning capability', async ({
  page,
  corral,
}) => {
  const path = join(corral.workspace, 'import-models.toml');
  writeFileSync(
    path,
    'model = "gpt-test-a"\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"',
  );
  await corral.open('/settings/models');
  const panel = page.getByRole('region', { name: 'Import model settings' });
  await panel.getByRole('combobox', { name: 'Source', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await panel.getByLabel('Configuration file (optional)').fill(path);
  await panel.getByRole('button', { name: 'Preview settings' }).click();
  await expect(panel.getByText('openai / gpt-test-a', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Import selected (0)' })).toBeDisabled();
  await panel.getByRole('checkbox', { name: /openai \/ gpt-test-a/ }).check();
  await panel.getByRole('button', { name: 'Import selected (1)' }).click();
  await expect(panel.getByRole('status')).toContainText('Settings saved and read back');
  const imported = page.locator('[data-testid^="profile-import-"]');
  await expect(imported).toContainText('gpt-test-a');
  await page.reload();
  await expect(page.locator('[data-testid^="profile-import-"]')).toContainText('gpt-test-a');
  await panel.getByRole('button', { name: 'View model metadata' }).click();
  await expect(panel.getByText('No cached catalog. Refresh to download metadata.')).toBeVisible();
  expect(corral.errors).toEqual([]);
});

test('[TC-ABS-005-N] unsupported configuration stays unselectable without leaking keys', async ({
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
  const panel = page.getByRole('region', { name: 'Import model settings' });
  await panel.getByLabel('Configuration file (optional)').fill(path);
  await panel.getByRole('button', { name: 'Preview settings' }).click();
  await expect(panel.getByRole('checkbox')).toBeDisabled();
  await expect(
    panel.getByText('Custom Anthropic endpoints are not supported by this importer.'),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Import selected (0)' })).toBeDisabled();
  expect(await page.content()).not.toContain(secret);
  expect(corral.errors).toEqual([]);
});
