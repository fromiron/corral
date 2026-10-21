import { linearCorral } from '@corral/testkit';
import { expect, test } from './harness.ts';

test('[TC-ABS-014-H] Editor Run retries its lost start after a full renderer reload without a second Run', async ({
  page,
  corral,
}, testInfo) => {
  // The only supplied native capability is the immutable host namespace normally exposed
  // by Electron's isolated preload. The real Studio, server, auth, commands and storage run.
  // This does not exercise an SSH handshake or claim remote-machine verification.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'corralRemote', {
      value: Object.freeze({ hostId: 'host_00000000-0000-0000-0000-000000000014' }),
    });
  });
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'remote-editor.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(linearCorral(['writer']))),
  });
  await expect(page).toHaveURL(/\/edit$/);
  const posted: string[] = [];
  const receiptReads: string[] = [];
  const missingReceipts: string[] = [];
  let firstRunId = '';
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/start-commands/')) receiptReads.push(request.url());
  });
  page.on('response', (response) => {
    if (response.status() === 404) missingReceipts.push(response.url());
  });
  await page.route('**/api/v1/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted.push(route.request().postDataJSON().commandId);
    if (posted.length === 1) {
      const response = await route.fetch();
      const result = await response.json();
      expect(response.ok()).toBe(true);
      firstRunId = result.runId;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(`${corral.server.url}/api/v1/runs`);
      const runs = await response.json();
      return runs.find((run: { runId: string }) => run.runId === firstRunId)?.status;
    })
    .toBe('succeeded');
  // A completed original Run can no longer mask a duplicate by blocking admission.
  await page.reload();
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toBeVisible();
  const response = await page.request.get(`${corral.server.url}/api/v1/runs`);
  const runs = await response.json();
  expect(runs).toHaveLength(1);
  expect(runs[0].runId).toBe(firstRunId);
  expect(posted).toHaveLength(1);
  expect(receiptReads.filter((url) => url.endsWith(`/${posted[0]}`))).toHaveLength(2);
  expect(missingReceipts).toEqual([`${corral.server.url}/api/v1/start-commands/${posted[0]}`]);
  await page.screenshot({ path: testInfo.outputPath('editor-recovered.png') });
  expect(corral.errors.filter((message) => !message.includes('net::ERR_FAILED'))).toEqual([
    expect.stringContaining('404 (Not Found)'),
  ]);
});
