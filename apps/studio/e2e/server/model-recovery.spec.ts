import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, compatibleEndpoint: true });

test('a request to a stopped endpoint explains the connection failure in the conversation', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(requestBox(page)).toBeVisible();
  await corral.endpoint?.close();
  await requestBox(page).fill('Check the local connection.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('failed');
  const conversation = page.getByTestId('chat-timeline');
  await expect(conversation.getByText('The model provider could not be reached.')).toBeVisible();
  await expect(
    conversation.getByText(
      'Check the network and endpoint address. Start the local model server if needed, then retry.',
    ),
  ).toBeVisible();
  await expect(conversation.getByText('This step failed.', { exact: false })).toHaveCount(0);
  await expect(
    conversation.locator('details[open]').filter({ hasText: 'Diagnostics' }),
  ).toHaveCount(0);
  expect(corral.errors).toEqual([]);
});

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
