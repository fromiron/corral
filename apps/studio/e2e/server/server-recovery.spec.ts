import { expect, test } from './harness.ts';

test('an expired server session explains reconnection and recovers with the current start link', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await corral.restart();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('the previous connection has expired');
  await expect(page.getByRole('alert')).toContainText('Open its current start link');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('the previous connection has expired');
  await corral.open('/');
  // The start link opens the project workspace again.
  await expect(
    page.getByRole('heading', { level: 1, name: 'My project', exact: true }),
  ).toBeVisible();
});
