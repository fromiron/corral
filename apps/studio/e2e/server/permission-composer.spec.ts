import type { WorkSession } from '@corral/core';
import type { Page } from '@playwright/test';
import { requestBox, slash, startSession, teamFromTemplate } from '../workbench.ts';
import { expect, test } from './harness.ts';

const picker = (page: Page) =>
  page.getByRole('combobox', { name: 'Permissions for next request', exact: true });

async function choose(page: Page, name: string) {
  await picker(page).click();
  await page
    .getByRole('option')
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
}

async function readSession(page: Page): Promise<WorkSession> {
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  const response = await page.request.get(
    new URL(`/api/v1/sessions/${sessionId}`, page.url()).href,
  );
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('the Auto composer restores a permission draft and starts with that policy', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(picker(page)).toContainText('Default policy');
  await choose(page, 'Ask');
  await requestBox(page).fill('Summarize the permission choice.');
  await page.reload();
  await expect(picker(page)).toContainText('Ask');
  await expect(requestBox(page)).toHaveValue('Summarize the permission choice.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(1);
  const runId = corral.server.coordinator.listRuns()[0]?.runId;
  if (!runId) throw new Error('Auto request did not start');
  expect(corral.server.coordinator.getRunSnapshot(runId)?.permissionMode).toBe('ask');
  await expect.poll(async () => (await readSession(page)).entries[0]?.permissionMode).toBe('ask');
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  await expect(picker(page)).toContainText('Default policy');
});

test.describe('queued permission ownership', () => {
  test.use({ replyDelayMs: 1500 });
  test('a team run consumes the saved queue policy instead of the current picker', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await teamFromTemplate(page);
    await startSession(page, 'Permission queue');
    await choose(page, 'Accept edits');
    await requestBox(page).fill('First request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(1);
    const firstRunId = corral.server.coordinator.listRuns()[0]?.runId;
    if (!firstRunId) throw new Error('Team request did not start');
    expect(corral.server.coordinator.getRunSnapshot(firstRunId)?.permissionMode).toBe(
      'accept_edits',
    );
    await slash(page, 'queue');
    await choose(page, 'Ask');
    await requestBox(page).fill('Queued request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(async () => (await readSession(page)).entries.at(-1)?.permissionMode)
      .toBe('ask');
    const queue = page.getByRole('region', { name: 'Queued next tasks' });
    await expect(queue).toContainText('Queued request');
    await expect(queue.getByRole('button', { name: 'Start now' })).toBeEnabled({
      timeout: 20_000,
    });
    await choose(page, 'Auto');
    await queue.getByRole('button', { name: 'Start now' }).click();
    await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(2);
    const nextRun = corral.server.coordinator.listRuns().find((run) => run.runId !== firstRunId);
    if (!nextRun) throw new Error('Queued request did not start');
    expect(corral.server.coordinator.getRunSnapshot(nextRun.runId)?.permissionMode).toBe('ask');
    await page.reload();
    const persisted = await readSession(page);
    expect(persisted.entries.at(-1)).toMatchObject({
      permissionMode: 'ask',
      state: 'started',
      runId: nextRun.runId,
    });
  });
});
