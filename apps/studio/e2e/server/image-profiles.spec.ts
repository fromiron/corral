import { modelSettingsTab, newTeam, openLibraryTeams, openProject } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, reasoningApi: true });

test('image profile CRUD and role configuration persist through the normal settings and editor flow', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/models');
  // Image profiles are the Images tab of the models settings; a reload opens on Sign-in.
  await modelSettingsTab(page, 'Images');
  const section = page.getByRole('region', { name: 'Image generation', exact: true });
  await section.getByRole('button', { name: 'Add image profile' }).click();
  await section.getByRole('combobox', { name: 'Provider model profile', exact: true }).click();
  const options = page.getByRole('option');
  await expect(options).not.toHaveCount(0);
  const profile = (await options.first().textContent())?.trim();
  if (!profile) throw new Error('No provider profile available');
  await options.first().click();
  await section.getByLabel('Image model ID').fill('image-test');
  const id = section.getByRole('definition');
  await expect(id).toHaveText(`${profile}:image-test`);
  const profileId = `${profile}:image-test`;
  await section.getByRole('button', { name: 'Save image profile' }).click();
  await expect(section.getByRole('status')).toHaveText('Image profile saved.');
  await section.getByRole('button', { name: 'Edit', exact: true }).click();
  await section.getByLabel('Timeout (seconds)').fill('90');
  await section.getByRole('button', { name: 'Save image profile' }).click();
  await expect(section.getByRole('status')).toHaveText('Image profile saved.');
  await page.reload();
  await modelSettingsTab(page, 'Images');
  await expect(section.getByText(profileId, { exact: true })).toBeVisible();
  await section.screenshot({ path: test.info().outputPath('image-profiles.png') });
  const stored = await page.evaluate(async () => (await fetch('/api/v1/image-profiles')).json());
  expect(stored.profiles).toContainEqual(
    expect.objectContaining({
      profileId,
      modelId: 'image-test',
      timeoutMs: 90000,
    }),
  );
  expect(JSON.stringify(stored)).not.toMatch(/apiKey|accessToken|refreshToken/);

  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await openProject(page, 'My project');
  await openLibraryTeams(page);
  await newTeam(page);
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await page.getByRole('switch', { name: /Generate images/ }).check();
  await page.getByRole('combobox', { name: 'Image profile', exact: true }).click();
  await page
    .getByRole('option', { name: new RegExp(profileId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .click();
  await page.screenshot({ path: test.info().outputPath('image-role.png') });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved. New revision.' })).toBeVisible();
  await page.reload();
  const path = new URL(page.url()).pathname
    .replace('/edit', '')
    .replace('/corrals/', '/api/v1/corrals/');
  const saved = await page.evaluate(async (path) => (await fetch(path)).json(), path);
  expect(saved.definition.roles[0]).toMatchObject({ imageProfile: profileId });
  expect(saved.definition.roles[0].allowedWorkTools).toContain('generate_image');
  expect(saved.definition.roles[0].allowedWorkTools).not.toContain('run_command');

  // Reopen after a closed-app restart; leave no old page polling the stopped server.
  await page.goto('about:blank');
  await corral.restart();
  await corral.open('/settings/models');
  await modelSettingsTab(page, 'Images');
  await expect(section.getByText(profileId, { exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Delete', exact: true }).click();
  await section.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(section.getByText(profileId, { exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Delete', exact: true }).click();
  await section.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(section.getByText('No image profiles configured.')).toBeVisible();
  await page.reload();
  await modelSettingsTab(page, 'Images');
  await expect(section.getByText('No image profiles configured.')).toBeVisible();
  expect(corral.errors).toEqual([]);
});
