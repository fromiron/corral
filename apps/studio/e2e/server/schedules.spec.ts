import { expect, test } from './harness.ts';

test('save a disabled schedule, run through Auto, and reopen its persisted history', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  await page.getByRole('link', { name: 'Schedules', exact: true }).click();
  await page.getByRole('button', { name: 'New schedule', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Daily project review');
  await page.getByLabel('Request', { exact: true }).fill('Summarize the available information.');
  await expect(page.getByLabel('Enable scheduled runs')).not.toBeChecked();
  await page.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(page.getByRole('button', { name: /Daily project review/ })).toBeVisible();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  const history = page.getByRole('region', { name: 'Run history' });
  await expect(history.getByRole('link', { name: 'Open run / respond' })).toBeVisible();
  await history.getByRole('link', { name: 'Open run / respond' }).click();
  await expect(page).toHaveURL(/\/sessions\/session_.*run=run_/);
  await page.getByRole('link', { name: 'Schedules', exact: true }).click();
  await page.getByRole('button', { name: /Daily project review/ }).click();
  await expect(page.getByLabel('Enable scheduled runs')).not.toBeChecked();
  await expect(
    page
      .getByRole('region', { name: 'Run history' })
      .getByRole('link', { name: 'Open run / respond' }),
  ).toHaveCount(1);
  await corral.restart();
  await corral.open('/schedules');
  await page.getByRole('button', { name: /Daily project review/ }).click();
  await expect(
    page
      .getByRole('region', { name: 'Run history' })
      .getByRole('link', { name: 'Open run / respond' }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete schedule', exact: true }).click();
  await expect(page.getByRole('button', { name: /Daily project review/ })).toHaveCount(0);
  expect(corral.errors).toEqual([]);
});
