import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

function handle(page: Page, nodeId: string, port: string) {
  return page.locator(
    `.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${port}"]`,
  );
}

async function agentToOutput(page: Page) {
  await page.getByRole('button', { name: 'New Corral' }).click();
  await expect(page).toHaveURL(/\/corrals\/corral_[a-z0-9]+\/edit/);
  await page.getByRole('button', { name: 'Add Agent' }).click();
  await page.getByRole('button', { name: 'Add Output' }).click();
  await handle(page, 'agent_1', 'out').dragTo(handle(page, 'output_1', 'in'));
  await expect(page.getByText('Ready to run.')).toBeVisible();
}

test('[TC-CAN-001-H] a run on the local server saves first, finishes, and survives a reload', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await expect(page.getByText('Local server / Simulated agents')).toBeVisible();
  await agentToOutput(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // The run started from a saved revision: nothing is left unsaved.
  await expect(page.getByText('All changes saved')).toBeVisible();
  await expect(page.getByTestId('run-output')).toContainText('Agent 1 (agent_1) turn 2');

  await page.getByRole('link', { name: 'Open run page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_[a-f0-9]+/);
  // CR-009: a finished run opens on its results; these checks are about the run view.
  await page.getByRole('tab', { name: 'Run', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('run-output')).toContainText('Agent 1 (agent_1) turn 2');
  expect(corral.errors).toEqual([]);
});

test('the workspace lists past runs with their status and opens them', async ({ page, corral }) => {
  await corral.open('/');
  await agentToOutput(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toContainText('turn 2');

  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
  const runs = page.getByRole('list', { name: 'Runs' });
  await expect(runs.getByRole('listitem')).toHaveCount(1);
  await expect(runs).toContainText('Succeeded');
  await runs.getByRole('link').click();
  // CR-009: a finished run opens on its results; this check is about the run view's Output tab.
  await page.getByRole('tab', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toContainText('turn 2');
});

test.describe('slow replies', () => {
  test.use({ replyDelayMs: 2000 });

  test('[TC-RNS-001-H] a steer sent over HTTP reaches the next request', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await agentToOutput(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const box = page.getByLabel('Instruction');
    await box.fill('Use primary sources only.');
    await box.press('Enter');
    const instruction = page.getByRole('listitem').filter({ hasText: 'Use primary sources only.' });
    await expect(instruction).toContainText('Queued');
    await expect(instruction).toContainText('Delivered', { timeout: 10_000 });
    await expect(page.getByTestId('run-output')).toContainText('Use primary sources only.', {
      timeout: 10_000,
    });
    expect(corral.errors).toEqual([]);
  });

  test('[TC-RUN-007-H] a run cut off by a server restart shows as interrupted, not re-run', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await agentToOutput(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByRole('link', { name: 'Open run page' }).click();
    await expect(page).toHaveURL(/\/runs\/run_[a-f0-9]+/);
    const runPath = new URL(page.url()).pathname;

    await corral.restart();
    await corral.open(runPath);
    await expect(page.getByTestId('run-status')).toContainText('Interrupted');
    // Nothing runs after the restart: the status stays and no output appears.
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('run-status')).toContainText('Interrupted');
    await expect(page.getByTestId('run-output')).toHaveCount(0);
  });
});

test('[TC-SEC-002-H] Studio works under the strict CSP, and a tab without a session says so', async ({
  page,
  corral,
}) => {
  const violations: string[] = [];
  await page.exposeFunction('reportViolation', (text: string) => violations.push(text));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { reportViolation(t: string): void }).reportViolation(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  await corral.open('/');
  await agentToOutput(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toContainText('turn 2');
  expect(violations).toEqual([]);
  expect(page.url()).not.toContain('bootstrap');

  // A second browser profile with the plain address has no session.
  const other = await page.context().browser()?.newPage();
  if (!other) throw new Error('no browser');
  await other.goto(corral.server.url);
  await expect(other.getByRole('alert')).toContainText('no session with the local server');
  await other.close();
});
