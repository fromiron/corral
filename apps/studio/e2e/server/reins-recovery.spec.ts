import { linearCorral } from '@corral/testkit';
import { openLibraryTeams, startTestRun } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ replyDelayMs: 1000 });

test('a lost command response recovers its receipt without submitting another directive', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await openLibraryTeams(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'receipt-recovery.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(linearCorral(['writer']))),
  });
  const posted: string[] = [];
  // Every receipt the page reads, by its command ID.
  const checked: string[] = [];
  page.on('request', (request) => {
    const read = new URL(request.url()).pathname.match(
      /\/api\/v1\/runs\/[^/]+\/commands\/([^/]+)$/,
    );
    if (request.method() === 'GET' && read?.[1]) checked.push(decodeURIComponent(read[1]));
  });
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
  await startTestRun(page);
  const input = page.getByLabel('Instruction', { exact: true });
  await input.fill('Recover this instruction exactly once.');
  await input.press('Enter');
  // The lost answer is said once, in the execution's Reins and in the product's words; the run's
  // head has no row for an instruction to one execution, and the draft stays for the next try.
  const reins = page.getByRole('region', { name: /^Reins · / });
  const unconfirmed = 'Receipt not confirmed. Check the run before retrying.';
  await expect(reins.getByRole('alert')).toHaveText(unconfirmed);
  await expect(page.getByText(unconfirmed)).toHaveCount(1);
  await expect(page.locator('body')).not.toContainText('Failed to fetch');
  await expect(page.getByRole('button', { name: 'Check receipt and retry safely' })).toHaveCount(0);
  await expect(input).toHaveValue('Recover this instruction exactly once.');
  expect(posted).toHaveLength(1);
  // Sent again from the Reins, it goes under the same command ID: its receipt is read first, and
  // the host already holding it, nothing is posted again.
  const before = checked.length;
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(checked.slice(before)).toContain(posted[0]);
  expect(new Set(checked)).toEqual(new Set(posted));
  await expect(reins.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText(unconfirmed)).toHaveCount(0);
  await expect(page.getByTestId('run-output')).toContainText(
    'Recover this instruction exactly once.',
  );
  expect(posted).toHaveLength(1);
  expect(corral.errors.filter((message) => !message.includes('net::ERR_FAILED'))).toEqual([]);
});
