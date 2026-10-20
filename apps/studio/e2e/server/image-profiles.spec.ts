import { expect, test } from './harness.ts';

test.use({ live: true, reasoningApi: true });

test('[TC-ABS-010-H] image profile CRUD and role configuration persist through the normal settings and editor flow', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/models');
  const section = page.getByRole('region', { name: 'Image generation', exact: true });
  await section.getByRole('button', { name: 'Add image profile' }).click();
  await section.getByLabel('Image profile ID', { exact: true }).fill('illustration');
  const profiles = await section
    .getByLabel('Provider model profile')
    .locator('option')
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
    );
  expect(profiles.length).toBeGreaterThan(0);
  const profile = profiles[0];
  if (!profile) throw new Error('No provider profile available');
  await section.getByLabel('Provider model profile').selectOption(profile);
  await section.getByLabel('Image model ID').fill('image-test');
  await section.getByLabel('Maximum cost per call (USD)').fill('0.25');
  await section.getByRole('button', { name: 'Save image profile' }).click();
  await expect(section.getByRole('status')).toHaveText('Image profile saved.');
  await section.getByRole('button', { name: 'Edit', exact: true }).click();
  await section.getByLabel('Maximum calls per run').fill('2');
  await section.getByRole('button', { name: 'Save image profile' }).click();
  await expect(section.getByRole('status')).toHaveText('Image profile saved.');
  await page.reload();
  await expect(section.getByText('illustration', { exact: true })).toBeVisible();
  await section.screenshot({ path: test.info().outputPath('image-profiles.png') });
  const stored = await page.evaluate(async () => (await fetch('/api/v1/image-profiles')).json());
  expect(stored.profiles).toContainEqual(
    expect.objectContaining({
      profileId: 'illustration',
      modelId: 'image-test',
      maxCallsPerRun: 2,
      maxCostUsdPerCall: 0.25,
    }),
  );
  expect(JSON.stringify(stored)).not.toMatch(/apiKey|accessToken|refreshToken/);

  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await page.getByRole('checkbox', { name: /Generate images/ }).check();
  await page.getByRole('textbox', { name: /^Image profile ID/ }).fill('illustration');
  await page.screenshot({ path: test.info().outputPath('image-role.png') });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  const path = new URL(page.url()).pathname
    .replace('/edit', '')
    .replace('/corrals/', '/api/v1/corrals/');
  const saved = await page.evaluate(async (path) => (await fetch(path)).json(), path);
  expect(saved.definition.roles[0]).toMatchObject({ imageProfile: 'illustration' });
  expect(saved.definition.roles[0].allowedWorkTools).toContain('generate_image');
  expect(saved.definition.roles[0].allowedWorkTools).not.toContain('run_command');

  // Reopen after a closed-app restart; leave no old page polling the stopped server.
  await page.goto('about:blank');
  await corral.restart();
  await corral.open('/settings/models');
  await expect(section.getByText('illustration', { exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Delete', exact: true }).click();
  await section.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(section.getByText('illustration', { exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Delete', exact: true }).click();
  await section.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(section.getByText('No image profiles configured.')).toBeVisible();
  await page.reload();
  await expect(section.getByText('No image profiles configured.')).toBeVisible();
  expect(corral.errors).toEqual([]);
});
