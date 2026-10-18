import { linearCorral } from '@corral/testkit';
import { expect, test } from './harness.ts';

test.use({ replyDelayMs: 1000 });

test('[TC-RACE-08] a lost command response recovers its receipt without submitting another directive', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'receipt-recovery.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(linearCorral(['writer']))),
  });
  const posted: string[] = [];
  await page.route('**/api/v1/runs/*/commands', async (route) => {
    const command = route.request().postDataJSON();
    if (command?.type === 'steer') {
      posted.push(command.commandId);
      if (posted.length === 1) {
        await route.fetch();
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const input = page.getByLabel('Instruction', { exact: true });
  await input.fill('Recover this instruction exactly once.');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Check receipt and retry safely' }).click();
  await expect(input).toHaveValue('');
  await expect(
    page.getByRole('region', { name: 'Reins', exact: true }).getByRole('listitem'),
  ).toHaveCount(1);
  await expect(page.getByTestId('run-output')).toContainText(
    'Recover this instruction exactly once.',
  );
  expect(posted).toHaveLength(1);
  expect(corral.errors.filter((message) => !message.includes('net::ERR_FAILED'))).toEqual([]);
});
