import { expect, test } from './harness.ts';

test.use({ live: true, compatibleEndpoint: true });

test('model settings keep configuration distinct from endpoint reachability and explain recovery', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/models');
  await expect(
    page.getByTestId('profile-model-a').getByText('Configured', { exact: true }),
  ).toBeVisible();
  const provider = page.getByTestId('provider-local');
  await provider.getByRole('button', { name: 'Test connection', exact: true }).click();
  // The fixture serves inference only; a metadata 404 must not trigger inference fallback.
  await expect(
    provider.getByRole('status').filter({ hasText: 'does not support the connection check' }),
  ).toBeVisible();
  expect(corral.endpoint?.models).toEqual([]);
  await corral.endpoint?.close();
  await provider.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(
    provider
      .getByRole('status')
      .filter({ hasText: 'Could not connect. Check the address, network, and local server.' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await provider.scrollIntoViewIfNeeded();
  await expect(
    provider.getByRole('button', { name: 'Test connection', exact: true }),
  ).toBeInViewport();
  await provider.screenshot({ path: test.info().outputPath('endpoint-recovery.png') });
  expect(corral.errors).toEqual([]);
});
