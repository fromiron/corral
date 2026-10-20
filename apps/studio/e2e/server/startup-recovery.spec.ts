import { expect, test } from './harness.ts';

test('[TC-ABS-014-N] server connection failure stays on its host and retries the same session', async ({
  page,
  corral,
}) => {
  await page.route('**/api/v1/health', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }),
  );
  // This deliberately exercises startup failure, before the normal harness's ready banner.
  await page.goto(corral.server.bootstrapUrl);
  await expect(page.getByRole('alert')).toHaveText(
    'Corral could not connect to this server. Check the connection, then try again.',
  );
  await expect(page.getByText('Browser · simulated', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/#bootstrap=/);
  await page.unroute('**/api/v1/health');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Local · simulated', { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/#bootstrap=/);
});
