import { linearCorral } from '@corral/testkit';
import { expect, test } from '@playwright/test';

test('[TC-RNS-001-N] an unsent instruction stays bound to its original execution', async ({
  page,
}) => {
  // The reviewer must still be running when the run is paused: a wide window for slow,
  // loaded runners (seen failing under a full parallel run). Assertions are unchanged.
  await page.goto('/?delay=1500');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'draft-binding.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(linearCorral(['writer', 'reviewer']))),
  });
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Reins', exact: true });
  const input = page.getByLabel('Instruction', { exact: true });
  await expect(panel.locator('dd').first()).toContainText('writer');
  await input.fill('An instruction originally drafted for writer.');
  await expect(panel.locator('dd').first()).toContainText('reviewer');
  await page.getByRole('button', { name: 'Pause run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Paused');
  await expect(input).toHaveValue('An instruction originally drafted for writer.');
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await input.press('Enter');
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Use draft for this execution' }).click();
  await input.press('Enter');
  await expect(panel.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Resume run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toContainText(
    'An instruction originally drafted for writer.',
  );
});
