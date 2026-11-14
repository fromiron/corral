import { linearCorral } from '@corral/testkit';
import { expect, test } from '@playwright/test';
import { openLibraryTeams, startTestRun } from './workbench.ts';

test('an unsent instruction stays bound to its original execution', async ({ page }) => {
  // The pause must land during the reviewer's first simulated request (each takes `delay`),
  // or the reviewer has no later request to carry the instruction and it expires. Under a
  // full parallel run, seeing the reviewer and clicking Pause took up to three seconds.
  test.setTimeout(90_000);
  await page.goto('/?delay=5000');
  await openLibraryTeams(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'draft-binding.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(linearCorral(['writer', 'reviewer']))),
  });
  await startTestRun(page);
  const panel = page.getByRole('region', { name: /^Reins · / });
  const input = page.getByLabel('Instruction', { exact: true });
  await expect(panel.locator('dd').first()).toContainText('writer');
  await input.fill('An instruction originally drafted for writer.');
  // An expect that has waited a while retries only once a second, which would spend most of
  // that window; waitFor checks every frame.
  await panel.locator('dd').first().filter({ hasText: 'reviewer' }).waitFor();
  await page.getByRole('button', { name: 'Pause run', exact: true }).click();
  // Paused once the reviewer's first request settles.
  await expect(page.getByTestId('run-status')).toContainText('Paused', { timeout: 15_000 });
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
    { timeout: 15_000 },
  );
});
