import { expect, test } from './harness.ts';

test('[TC-UX-006-H] [TC-UX-006-N] settings guard preserves failed edits and saves only their selected target', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/harness');
  await page.getByLabel('Work style name', { exact: true }).fill('Guarded style');
  await page.getByRole('link', { name: 'Personal default work style', exact: true }).click();
  const guard = page.getByRole('dialog', { name: 'Unsaved settings' });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByLabel('Work style name', { exact: true })).toHaveValue('Guarded style');
  await page.getByRole('link', { name: 'Personal default work style', exact: true }).click();
  await guard.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page).toHaveURL(/\/settings\/defaults/);
  const choose = page.getByRole('combobox', { name: 'Personal default', exact: true });
  await choose.click();
  await page.getByRole('option', { name: 'Guarded style · r1', exact: true }).click();
  await page.route('**/harness/defaults/personal/default', async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({
        status: 409,
        json: { error: { code: 'REVISION_CONFLICT', message: 'Revision changed' } },
      });
    else await route.fallback();
  });
  await page.getByRole('link', { name: 'General', exact: true }).click();
  await guard.getByRole('button', { name: 'Save and continue' }).click();
  await expect(guard.getByRole('alert')).toBeVisible();
  await guard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(choose).toContainText('Guarded style');
  await page.getByRole('link', { name: 'General', exact: true }).click();
  await guard.getByRole('button', { name: 'Discard changes' }).click();
  await expect(
    page.locator('.settings-content').getByRole('heading', { name: 'General', exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(async () =>
    (await fetch('/api/v1/harness/defaults/personal/default')).json(),
  );
  expect(saved.binding).toBeNull();
});
