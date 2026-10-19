import { expect, test } from './harness.ts';

test('[TC-UX-004-H] [TC-UX-004-N] defaults have independent routes and save only their explicit scope', async ({
  page,
  corral,
}) => {
  await corral.open('/settings');
  await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const response = await fetch('/api/v1/harness/profiles/settings-test', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        expectedRevision: 0,
        profile: {
          name: 'Settings test',
          policy: 'strict',
          resources: [],
          allowedTools: ['submit_result'],
          startupCommands: [],
        },
      }),
    });
    if (!response.ok) throw new Error('Profile fixture failed');
  });
  await page.goto(
    `${corral.server.url}/settings/harness?projectId=default&returnTo=%2Fprojects%2Fdefault#project-defaults`,
  );
  await expect(page).toHaveURL(/\/settings\/project-defaults\?/);
  await expect(page.getByLabel('Work style name', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('settings-sidebar').locator('[aria-current="page"]')).toHaveCount(
    1,
  );
  const choose = page.getByRole('combobox', { name: 'Project default', exact: true });
  await expect(choose).toBeInViewport();
  await choose.click();
  await page.getByRole('option', { name: 'Settings test · r1', exact: true }).click();
  const read = () =>
    page.evaluate(async () =>
      Promise.all(
        ['project/default', 'personal/default'].map(async (scope) =>
          (await fetch(`/api/v1/harness/defaults/${scope}`)).json(),
        ),
      ),
    );
  expect((await read()).map((d) => d.binding)).toEqual([null, null]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(choose).toContainText('None');
  await choose.click();
  await page.getByRole('option', { name: 'Settings test · r1', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Default saved');
  const saved = await read();
  expect(saved[0].binding).toEqual({ profileId: 'settings-test', revision: 1 });
  expect(saved[1].binding).toBeNull();
  await page.getByRole('link', { name: 'Personal default work style', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Personal default', exact: true })).toContainText(
    'None',
  );
  const personal = page.getByRole('combobox', { name: 'Personal default', exact: true });
  await personal.click();
  await page.getByRole('option', { name: 'Settings test · r1', exact: true }).click();
  await page.route('**/harness/defaults/personal/default', async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({
        status: 409,
        json: { error: { code: 'SCHEMA_INVALID', message: 'default revision changed' } },
      });
    else await route.fallback();
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('default revision changed');
  await expect(personal).toContainText('Settings test');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
  await expect(page).toHaveURL(/settings\/defaults/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await read())[1].binding).toBeNull();
  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/default$/);
  expect(corral.errors).toHaveLength(1);
  expect(corral.errors[0]).toContain('409');
});
