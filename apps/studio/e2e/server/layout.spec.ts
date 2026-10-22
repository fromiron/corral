import { expect, test } from './harness.ts';

// Settings layout regressions from the workbench audit (#75 onwards) that need the server.

test.describe('model profiles', () => {
  // Profiles appear when the workspace has model configuration (as in models.spec.ts).
  test.use({ live: true });
  test('#75 model profile fields keep visible titles and a visible remove action', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    await page.getByRole('button', { name: 'Edit models' }).click();
    const editor = page.getByRole('region', { name: 'Edit models' });
    await expect(editor.getByText('Profile name', { exact: true }).first()).toBeVisible();
    await expect(editor.getByText('Provider', { exact: true }).first()).toBeVisible();
    await expect(editor.getByText('Model', { exact: true }).first()).toBeVisible();
    const remove = editor.getByRole('button', { name: 'Remove model-a', exact: true });
    await expect(remove).toHaveText('Remove');
    // The accessible names stay on the controls.
    await expect(
      editor.getByRole('combobox', { name: 'Model of model-a', exact: true }),
    ).toBeVisible();
    expect(corral.errors).toEqual([]);
  });
});

test('#75 the archived resources filter is named by its visible text', async ({ page, corral }) => {
  await corral.open('/settings/skills');
  const filter = page.getByRole('checkbox', { name: 'Show archived items', exact: true });
  await expect(filter).toBeVisible();
  await page.getByText('Show archived items', { exact: true }).click();
  await expect(filter).toBeChecked();
  expect(corral.errors).toEqual([]);
});
