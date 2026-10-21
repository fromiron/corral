import { expect, test } from './harness.ts';

test.use({ live: true });
test('[TC-ABS-013-H] encrypted file restores actual browser preferences through preview and acknowledgement', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/vault');
  await page.getByLabel('Vault password', { exact: true }).fill('local test vault password');
  await page.getByRole('checkbox', { name: 'Models and providers', exact: true }).uncheck();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download encrypted settings', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Encrypted settings file was not downloaded.');
  // Change the actual setting through its ordinary UI, then restore the saved value.
  await page.getByRole('link', { name: 'General', exact: true }).click();
  const previous = await page.getByRole('radio', { name: 'System', exact: true }).isChecked();
  expect(previous).toBe(true);
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await page.getByRole('link', { name: 'Settings vault', exact: true }).click();
  await page.getByLabel('Vault password', { exact: true }).fill('local test vault password');
  await page.getByLabel('Encrypted settings file', { exact: true }).setInputFiles(path);
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  const restore = page.getByRole('region', { name: 'Restore settings', exact: true });
  await restore.getByRole('checkbox', { name: /Application/ }).check();
  await restore.getByRole('button', { name: 'Apply selected (1)', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Selected settings applied and read back.');
  await page.reload();
  await page.getByRole('link', { name: 'General', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'System', exact: true })).toBeChecked();
  expect(corral.errors).toEqual([]);
});

test('[TC-ABS-013-N] incorrect vault password fails before any settings change', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/vault');
  await page.getByLabel('Vault password', { exact: true }).fill('local test vault password');
  await page.getByRole('checkbox', { name: 'Models and providers', exact: true }).uncheck();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download encrypted settings', exact: true }).click();
  const path = await (await downloadPromise).path();
  if (!path) throw new Error('Encrypted settings file was not downloaded.');
  await page.getByLabel('Encrypted settings file', { exact: true }).setInputFiles(path);
  await page.getByLabel('Vault password', { exact: true }).fill('incorrect vault password');
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('authentication failed');
  await expect(page.getByRole('button', { name: /Apply selected/ })).toHaveCount(0);
  // The expected refused request is a 400; no renderer exception occurs.
  expect(corral.errors.filter((error) => !error.includes('400'))).toEqual([]);
});
