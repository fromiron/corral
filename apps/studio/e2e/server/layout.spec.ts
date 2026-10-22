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

test('#79 without a default, adoption points to the chosen scope defaults screen', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/skills');
  await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, body: unknown, method = 'POST') => {
      const response = await fetch(`/api/v1/harness${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`setup failed: ${path} ${response.status}`);
      return response.json();
    };
    const review = await call('/documents/review', {
      kind: 'skill',
      name: 'Writing',
      content: '---\nname: writing\ndescription: Layout fixture writer\n---\nAnswer briefly.',
    });
    const saved = await call('/resources', { reviewId: review.reviewId });
    await call(`/resources/${saved.hash}/trust`, { trusted: true }, 'PUT');
  });
  await page.reload();
  await page.getByRole('button', { name: /Layout fixture writer/ }).click();
  // One way to Work styles, named for what happens there.
  await expect(page.getByRole('link', { name: 'Connect in Work styles', exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole('link', { name: 'Manage work styles', exact: true })).toHaveCount(0);
  const panel = page.getByTestId('skill-quality');
  await panel.getByText('Evaluate, adopt and roll back', { exact: true }).click();
  const defaults = panel.getByRole('link', { name: /default work style/ });
  await expect(defaults).toHaveAttribute('href', /settings\/defaults|settings=defaults/);
  await panel.getByRole('combobox', { name: 'Apply to', exact: true }).click();
  await page.getByRole('option').nth(1).click();
  await expect(defaults).toHaveAttribute('href', /project-defaults/);
  expect(corral.errors).toEqual([]);
});

test('#80 settings say which project they target, that work styles are shared, and three selection states', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/harness');
  await expect(page.getByTestId('shared-scope')).toContainText('Shared work style');
  const checks = page.getByRole('combobox', {
    name: 'Select registered checks for this style',
    exact: true,
  });
  await expect(checks).toHaveText(/Follow the parent setting/);
  await checks.click();
  await page.getByRole('option', { name: 'Use none', exact: true }).click();
  await expect(checks).toHaveText(/Use none/);
  expect(corral.errors).toEqual([]);
});

test('#80 a project settings page shows its target project as a visible scope', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/mcp');
  await expect(page.getByText('Settings apply to project', { exact: true })).toBeVisible();
  expect(corral.errors).toEqual([]);
});
