import { modelSettingsTab, newConversation, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, compatibleEndpoint: true });

test('a request to a stopped endpoint explains the connection failure in the conversation', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await newConversation(page);
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
  // The connection's row: configured, it says how it connects until its model list is asked for.
  const provider = page.getByRole('article', { name: 'Local server', exact: true });
  await expect(provider).toContainText('No key · 1 model');
  await provider.getByRole('button', { expanded: false }).click();
  await provider.getByRole('button', { name: 'Refresh models', exact: true }).click();
  // The fixture serves inference only; a model list 404 must not trigger inference fallback.
  await expect(provider).toContainText('No model list here');
  await expect(
    provider.getByRole('button', { name: 'Edit address: Local server', exact: true }),
  ).toBeVisible();
  expect(corral.endpoint?.models).toEqual([]);
  // The model written in the settings stays listed.
  await expect(
    provider.getByRole('list', { name: 'Models of Local server', exact: true }),
  ).toContainText('llama3.2');
  await corral.endpoint?.close();
  await provider.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(provider).toContainText('Can’t reach the address');
  const retry = provider.getByRole('button', { name: 'Try again: Local server', exact: true });
  await expect(retry).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toBeInViewport();
  await provider.screenshot({ path: test.info().outputPath('endpoint-recovery.png') });
  // Unreachable is not unconfigured: the profile still points at the endpoint's model.
  const profiles = await modelSettingsTab(page, 'Profiles');
  const model = profiles.getByRole('button', { name: /^Model of model-a: / });
  await expect(model).toHaveAccessibleName('Model of model-a: llama3.2');
  await expect(model).not.toContainText('Not connected');
  expect(corral.errors).toEqual([]);
});
