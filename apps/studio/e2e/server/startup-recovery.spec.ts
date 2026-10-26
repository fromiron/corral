import { join } from 'node:path';
import { startCorralServer } from '@corral/server';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { expect, test } from './harness.ts';

test('new tabs keep their session after another local server authenticates', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const { csrfToken } = await (
    await page.request.get(`${corral.server.url}/api/v1/session`)
  ).json();
  const newTab = await page.context().newPage();
  const otherTab = await page.context().newPage();
  const otherWorkspace = join(corral.workspace, 'other-server');
  const otherServer = await startCorralServer({
    workspace: otherWorkspace,
    worktreeRoot: join(otherWorkspace, 'worktrees'),
    port: 0,
    staticDir: join(import.meta.dirname, '..', '..', 'dist'),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  try {
    await newTab.goto(corral.server.url);
    await expect(newTab.getByRole('banner')).toBeVisible();
    await otherTab.goto(otherServer.bootstrapUrl);
    await expect(otherTab.getByRole('banner')).toBeVisible();

    await newTab.reload();
    await expect(newTab.getByRole('banner')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('banner')).toBeVisible();
    await newTab.goto(corral.server.bootstrapUrl);
    await expect(newTab.getByRole('banner')).toBeVisible();
    const write = await page.request.put(`${corral.server.url}/api/v1/run-modes`, {
      headers: { origin: corral.server.url, 'x-corral-csrf': csrfToken },
      data: { key: 'tab', mode: 'mock' },
    });
    expect(write.status()).toBe(200);
    await otherTab.reload();
    await expect(otherTab.getByRole('banner')).toBeVisible();
  } finally {
    await newTab.close();
    await otherTab.close();
    await otherServer.close();
  }
});

test('bootstrap links work in another profile and expire when the server restarts', async ({
  page,
  browser,
  corral,
}) => {
  await corral.open('/');
  const otherProfile = await browser.newContext();
  try {
    const otherTab = await otherProfile.newPage();
    await otherTab.goto(corral.server.url);
    await expect(otherTab.getByRole('alert')).toContainText('no session with the local server');
    await otherTab.goto(corral.server.bootstrapUrl);
    await expect(otherTab.getByRole('banner')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('banner')).toBeVisible();

    const previousToken = new URL(corral.server.bootstrapUrl).hash;
    await corral.restart();
    await page.goto(corral.server.url);
    await expect(page.getByRole('alert')).toContainText('no session with the local server');
    await page.goto(`${corral.server.url}/${previousToken}`);
    await expect(page.getByRole('alert')).toContainText('no session with the local server');
    await corral.open('/');
    await expect(page.getByRole('banner')).toBeVisible();
  } finally {
    await otherProfile.close();
  }
});

test('server connection failure stays on its host and retries the same session', async ({
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
