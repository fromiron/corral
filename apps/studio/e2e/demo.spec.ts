import { linearCorral } from '@corral/testkit';
import { expect, type Page, test } from '@playwright/test';

test('the worker preserves receipts, replay ordering and cancellation boundaries', async ({
  page,
}) => {
  await page.goto('/demo?template=starter&delay=150');
  await expect(page.getByText('Ready to run.')).toBeVisible();
  const result = await page.evaluate(
    async (definition) => {
      const { createDemoTransport } = await import('../src/runtime.ts');
      const transport = createDemoTransport();
      const started = await transport.startRun({
        schemaVersion: '0.1',
        commandId: 'cmd_worker_start',
        definition,
        mode: 'mock',
      });
      if (!started.runId) throw new Error('No run');
      const runId = started.runId;
      let snapshot = await transport.getSnapshot(runId);
      while (!snapshot.projection.executionOrder.length) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        snapshot = await transport.getSnapshot(runId);
      }
      const executionId = snapshot.projection.executionOrder[0] ?? '';
      const command = {
        schemaVersion: '0.1',
        commandId: 'cmd_worker_cancel',
        runId,
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason: 'Worker cancellation check' },
      } as const;
      const seen: number[] = [];
      const unsubscribe = transport.subscribe(runId, snapshot.seq, {
        onEvent: (event) => seen.push(event.runSeq),
      });
      const receipt = await transport.sendCommand(command);
      const duplicate = await transport.sendCommand(command);
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
        snapshot = await transport.getSnapshot(runId);
      } while (snapshot.projection.status !== 'cancelled');
      const persisted = await transport.getReceipt(runId, command.commandId);
      const runs = await transport.listRuns();
      const savedDefinition = await transport.getRunDefinition(runId);
      const missingArtifact = await transport.getArtifactText(runId, 'version_missing');
      unsubscribe();
      const countAtUnsubscribe = seen.length;
      const replay: number[] = [];
      const stop = transport.subscribe(runId, 0, { onEvent: (event) => replay.push(event.runSeq) });
      await transport.getSnapshot(runId);
      stop();
      let subscriptionErrors = 0;
      transport.subscribe(runId, 0, {
        onEvent() {
          throw new Error('Consumer failed');
        },
        onError() {
          subscriptionErrors++;
        },
      });
      await transport.getSnapshot(runId);
      const missingRunRejected = await transport.getSnapshot('missing_run').then(
        () => false,
        () => true,
      );
      return {
        subscriptionErrors,
        missingRunRejected,
        receipt,
        duplicate,
        persisted,
        runs,
        definitionId: savedDefinition?.id,
        missingArtifact,
        replay,
        seen,
        countAtUnsubscribe,
        seq: snapshot.seq,
        status: snapshot.projection.status,
        executionId,
        artifacts: Object.keys(snapshot.projection.artifacts),
      };
    },
    linearCorral(['writer']),
  );
  expect(result.duplicate.commandId).toBe(result.receipt.commandId);
  expect(result.persisted?.status).toBe('applied');
  expect(result.runs).toHaveLength(1);
  expect(result.definitionId).toBeTruthy();
  expect(result.missingArtifact).toBeNull();
  expect(result.status).toBe('cancelled');
  expect(result.subscriptionErrors).toBe(1);
  expect(result.missingRunRejected).toBe(true);
  expect(result.artifacts).toEqual([]);
  expect(result.replay).toEqual(Array.from({ length: result.seq }, (_, index) => index + 1));
  expect(new Set(result.seen).size).toBe(result.seen.length);
  expect(result.seen.length).toBe(result.countAtUnsubscribe);
});

const approve = async (page: Page, kind: 'Your decision' | 'Final output') => {
  const card = page.locator('[data-testid^="approval-"]').filter({ hasText: kind });
  await expect(card).toBeVisible({ timeout: 20_000 });
  // UX-11: each step's button says what approving it does.
  await card
    .getByRole('button', {
      name: kind === 'Final output' ? 'Confirm as final result' : 'Continue with this version',
    })
    .click();
};

const step = (page: Page, id: string) =>
  page.getByRole('region', { name: 'Demo guide' }).locator(`[data-step="${id}"]`);

test('the default demo team delegates, asks, revises once and finishes after approval offline', async ({
  page,
  context,
}) => {
  const runtimeRequests: string[] = [];
  page.on('request', (request) => {
    if (['fetch', 'xhr', 'eventsource'].includes(request.resourceType()))
      runtimeRequests.push(request.url());
  });
  await page.goto('/demo?delay=200');
  await expect(page.getByLabel('Team name')).toHaveValue('Research team');
  await expect(page.getByText('Demo · simulated', { exact: true })).toBeVisible();
  await expect(page.getByText('Ready to run.')).toBeVisible();
  await expect(step(page, 'start')).toHaveAttribute('data-state', 'current');
  await context.setOffline(true);
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  // Research hands two parts to helpers, which appear under it in the call tree.
  const nested = page.locator('li[data-execution-id] li[data-execution-id]');
  await expect(nested.filter({ hasText: 'Research Helper' })).toHaveCount(2);
  await expect(step(page, 'delegate')).toHaveAttribute('data-state', 'done');
  // The Writer's question gets its own responder execution under the Writer.
  await expect(nested.filter({ hasText: 'Source Responder' }).first()).toBeVisible();
  await expect(step(page, 'ask')).toHaveAttribute('data-state', 'done', { timeout: 10_000 });
  // The first review asks for a revision, so the Writer runs a second round.
  const writers = page.locator('li[data-execution-id]').filter({ hasText: /^Writer ·/ });
  await expect(writers.filter({ hasText: 'Round 2' })).toHaveCount(1, { timeout: 15_000 });
  await expect(step(page, 'revise')).toHaveAttribute('data-state', 'done');

  await approve(page, 'Your decision');
  await approve(page, 'Final output');
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  const output = page.getByTestId('run-output');
  await expect(output).toContainText('Simulated');
  await expect(output).not.toContainText(/^read artv_/m);
  await expect(step(page, 'finish')).toHaveAttribute('data-state', 'done');
  expect(runtimeRequests).toEqual([]);
});

test('a rejected approval does not finish the run or the guide', async ({ page }) => {
  await page.goto('/demo?delay=150');
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const card = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Reject and stop' }).click();
  await expect(page.getByTestId('run-status')).not.toContainText(/Running|Waiting/, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('run-status')).not.toContainText('Succeeded');
  await expect(step(page, 'finish')).toHaveAttribute('data-state', 'missed');
  await expect(step(page, 'finish')).toContainText("Didn't happen in this run");
});

test('the guide can pause at round 2 so a visitor has time to steer at normal speed', async ({
  page,
}) => {
  // The pause travels worker → page → worker; on slow CI runners a 300 ms reply let the round 2
  // Writer finish first (its target then closes). A wider reply window; assertions unchanged.
  test.setTimeout(90_000);
  await page.goto('/demo?delay=1200');
  const arm = step(page, 'steer').getByLabel('Pause the run when the round 2 Writer starts');
  await arm.check();
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // The guide pauses through the normal run command, and points Reins at the round 2 Writer.
  await expect(page.getByTestId('run-status')).toContainText('Paused', { timeout: 20_000 });
  await expect(arm).toHaveCount(0);
  const reins = page.getByRole('region', { name: 'Reins', exact: true });
  const writers = page.locator('li[data-execution-id]').filter({ hasText: /^Writer ·/ });
  const round2 = await writers.filter({ hasText: 'Round 2' }).getAttribute('data-execution-id');
  await expect(reins).toContainText(`execution ${round2}`);
  await page.getByLabel('Instruction').fill('Lead with the cost difference.');
  await page.getByLabel('Instruction').press('Enter');
  await page.getByRole('button', { name: 'Resume run', exact: true }).click();
  await expect(step(page, 'steer')).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  await approve(page, 'Your decision');
  await approve(page, 'Final output');
  await expect(page.getByTestId('run-output')).toContainText('Lead with the cost difference.');
});
