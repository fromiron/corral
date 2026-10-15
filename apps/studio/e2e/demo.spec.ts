import { linearCorral } from '@corral/testkit';
import { expect, test } from '@playwright/test';

test('[TC-DEV-005-H] /demo starts a key-free worker runtime and steering changes its output offline', async ({
  page,
  context,
}) => {
  const runtimeRequests: string[] = [];
  page.on('request', (request) => {
    if (['fetch', 'xhr', 'eventsource'].includes(request.resourceType()))
      runtimeRequests.push(request.url());
  });
  // /demo must not probe or use a server even when the host injects its runtime marker.
  await page.addInitScript(() => {
    const meta = document.createElement('meta');
    meta.name = 'corral-runtime';
    meta.content = 'server';
    document.documentElement.append(meta);
  });
  const workerReady = page.waitForEvent('worker');
  await page.goto('/demo?delay=600');
  await expect(page.getByLabel('Corral name')).toHaveValue('Demo Corral');
  await workerReady;
  await expect(page.getByText('Demo / Simulated agents')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Models', exact: true })).toHaveCount(0);
  await expect(page.getByText('Ready to run.')).toBeVisible();
  // Once static assets are loaded, all editing and execution remains in this browser.
  await context.setOffline(true);
  await page.getByLabel('Run brief').fill('Compare fountain pens.');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByLabel('Instruction').fill('Use primary sources only.');
  await page.getByLabel('Instruction').press('Enter');
  await expect(page.getByTestId('run-output')).toContainText('Use primary sources only.');
  await expect(page.getByTestId('run-output')).toContainText('Compare fountain pens.');
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  expect(runtimeRequests).toEqual([]);
});

test('[TC-DEV-005-N] the worker preserves receipts, replay ordering and cancellation boundaries', async ({
  page,
}) => {
  await page.goto('/demo?delay=150');
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

test('[TC-DEV-005-H] a previewed future prompt patch changes only the downstream simulated activation', async ({
  page,
}) => {
  await page.goto('/demo?delay=500');
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await page.getByLabel('From out').selectOption({ label: 'Output · in' });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.react-flow__node[data-id="agent_1"]').click();
  await page.getByRole('button', { name: 'Remove connection to Output' }).click();
  await page.getByLabel('From out').selectOption({ label: 'Agent 2 · in' });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  // Control order and data bindings are separate: choose the downstream submitted version.
  await page.locator('.react-flow__node[data-id="output_1"]').click();
  const inputs = page.getByRole('button', { name: /^Remove input / });
  while (await inputs.count()) await inputs.first().click();
  await page.getByLabel('Kind', { exact: true }).selectOption('task_output');
  await page.getByLabel('From', { exact: true }).selectOption('agent_2');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Pause run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Paused');
  await page.getByText('Change settings', { exact: true }).click();
  await page.getByLabel('Change scope').selectOption('node_future');
  await page.getByLabel('Target node').selectOption('agent_2');
  await page.getByLabel('Proposed value').fill('Summarize the evidence as three bullet points.');
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  const confirmation = page.getByRole('button', { name: 'Confirm settings change', exact: true });
  await expect(confirmation).toBeEnabled();
  await confirmation.click();
  await expect(confirmation).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toContainText(
    'role prompt: Summarize the evidence as three bullet points.',
  );
  await expect(page.locator('[data-execution-id]')).toHaveCount(2);
});
