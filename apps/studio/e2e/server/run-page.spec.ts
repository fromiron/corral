import definition from '../../../../examples/research-brief.corral.json' with { type: 'json' };
import layout from '../../../../examples/research-brief.layout.json' with { type: 'json' };
import approvalDefinition from '../../../../examples/research-team.corral.json' with {
  type: 'json',
};
import approvalLayout from '../../../../examples/research-team.layout.json' with { type: 'json' };
import { panelTab, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

async function startRun(
  page: import('@playwright/test').Page,
  corral: { open(path?: string): Promise<void> },
  fixture: { definition: unknown; layout: { nodes: unknown; viewport: unknown } } = {
    definition,
    layout,
  },
) {
  await corral.open('/');
  return page.evaluate(async ({ definition, layout }) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, body: unknown) => {
      const response = await fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`setup ${path}: ${response.status}`);
      return response.json();
    };
    const saved = await call('/corrals', {
      definition,
      layout: { nodes: layout.nodes, viewport: layout.viewport },
    });
    const session = (
      await call('/sessions', {
        projectId: 'default',
        title: 'Run page fixture',
        corralId: saved.record.corralId,
      })
    ).session;
    const started = await call('/runs', {
      schemaVersion: '0.1',
      commandId: 'run-page-fixture',
      sessionId: session.sessionId,
      corralId: saved.record.corralId,
      definitionRevision: saved.record.definitionRevision,
      mode: 'mock',
    });
    return { runId: started.runId as string, sessionId: session.sessionId as string };
  }, fixture);
}

async function finishedRun(
  page: import('@playwright/test').Page,
  corral: { open(path?: string): Promise<void> },
) {
  const { runId } = await startRun(page, corral);
  await corral.open(`/runs/${runId}`);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await expect(page.getByRole('tab', { name: 'Graph', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  return new URL(page.url()).pathname;
}

test('a reload keeps the chosen execution and the saved layout', async ({ page, corral }) => {
  await finishedRun(page, corral);
  await expect(page.getByText('Layout from the saved team')).toBeVisible();
  await page
    .getByTestId('run-monitor')
    .getByRole('button', { name: 'Executions', exact: true })
    .click();
  const row = page.locator('li[data-execution-id]').filter({ hasText: 'Research Helper' }).first();
  const executionId = await row.getAttribute('data-execution-id');
  await row.getByRole('button', { name: 'Steer' }).first().click();
  await expect(page).toHaveURL(new RegExp(`execution=${executionId}`));
  await page.reload();
  await page.getByTestId('run-monitor').getByRole('tab', { name: 'Reins', exact: true }).click();
  const reins = page.getByRole('region', { name: 'Reins', exact: true });
  await expect(reins).toContainText(`execution ${executionId}`);
  await expect(page.locator(`li[data-execution-id="${executionId}"]`)).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(corral.errors).toEqual([]);
});

test('a link to an execution the run does not have targets nothing', async ({ page, corral }) => {
  const runPath = await finishedRun(page, corral);
  await corral.open(`${runPath}?execution=exec_9999`);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await expect(page.getByRole('alert')).toContainText('exec_9999 is not part of this run');
  await page.getByTestId('run-monitor').getByRole('tab', { name: 'Reins', exact: true }).click();
  const reins = page.getByRole('region', { name: 'Reins', exact: true });
  await expect(reins.getByLabel('Instruction')).toHaveCount(0);
  await expect(reins).not.toContainText('execution exec_');
});

test('ACTION-01 opens one scoped response host and keeps later typing focus', async ({
  page,
  corral,
}) => {
  const started = await startRun(page, corral, {
    definition: approvalDefinition,
    layout: approvalLayout,
  });
  await corral.open(`/sessions/${started.sessionId}`);
  const action = page.getByTestId('dock-open-active-run');
  await expect(action).toContainText('response needed');
  await action.click();
  const response = page.locator('[data-run-response]');
  await expect(response).toBeFocused();
  await expect(page.getByRole('button', { name: 'Continue with this version' })).toHaveCount(1);
  await response.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect(
    page.getByTestId('run-monitor').getByRole('region', { name: 'draft · Version 2', exact: true }),
  ).toBeVisible();
  await response.getByRole('button', { name: 'review v2', exact: true }).click();
  await expect(
    page
      .getByTestId('run-monitor')
      .getByRole('region', { name: 'review · Version 2', exact: true }),
  ).toBeVisible();
  await panelTab(page, 'Conversation');
  const input = requestBox(page);
  await input.fill('Keep typing while the run continues');
  await expect(input).toBeFocused();

  let releaseApproval!: () => void;
  const approvalReady = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });
  await page.route('**/api/v1/runs/*/commands', async (route) => {
    if (route.request().postDataJSON()?.type === 'resolve_approval') await approvalReady;
    await route.continue();
  });
  try {
    await panelTab(page, 'Execution history');
    const posted = page.waitForRequest(
      (request) =>
        request.url().endsWith('/commands') && request.postDataJSON()?.type === 'resolve_approval',
    );
    await response.getByRole('button', { name: 'Continue with this version' }).click();
    await posted;
    await panelTab(page, 'Conversation');
    await input.focus();
    releaseApproval();
    await expect(
      response.getByRole('button', { name: 'Confirm as final result', includeHidden: true }),
    ).toHaveCount(1);
    await expect(action).toContainText('response needed');
    await expect(input).toHaveValue('Keep typing while the run continues');
    await expect(input).toBeFocused();
  } finally {
    releaseApproval();
  }
  expect(corral.errors).toEqual([]);
});

test('history announces its cursor, conversation clears it, and Results Back returns to chat', async ({
  page,
  corral,
}, testInfo) => {
  const started = await startRun(page, corral);
  await expect
    .poll(() => corral.server.coordinator.getSnapshot(started.runId).projection.status)
    .toBe('succeeded');
  await corral.open(`/sessions/${started.sessionId}?panel=run&run=${started.runId}`);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await page
    .getByTestId('run-monitor')
    .getByRole('button', { name: 'Previous', exact: true })
    .click();
  await expect(page.getByText('Historical view', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/atSeq=/);
  await panelTab(page, 'Conversation');
  await expect(page).not.toHaveURL(/atSeq=/);
  await page.getByRole('link', { name: 'Open in Results', exact: true }).first().click();
  await expect(page.getByTestId('result-body')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Conversation', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(requestBox(page)).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem('corral:workbench:v1', JSON.stringify({ version: 1, theme: 'dark' })),
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  const historyTab = page.getByRole('tab', { name: 'Execution history', exact: true });
  await expect(historyTab).toBeVisible();
  await historyTab.click();
  const flow = page.locator('.corral-flow').first();
  await expect(flow).toBeVisible();
  await expect(flow).toHaveCSS('color-scheme', 'dark');
  const node = flow.locator('.react-flow__node [data-slot="card"]').first();
  await expect(node).toHaveCSS('background-color', 'rgb(37, 37, 37)');
  const labels = await flow.locator('.react-flow__edge-text').allTextContents();
  expect(labels.filter((label) => label === 'delegates')).toHaveLength(0);
  expect(labels.some((label) => label.includes('observed'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dark-history.png') });
  expect(corral.errors).toEqual([]);
});

let holdLifecycleReplies = false;
const lifecycleReplies: (() => void)[] = [];
test.describe('cancel recovery', () => {
  test.use({
    agentReply: {
      reply: () => 'Retry response',
      beforeReply: () =>
        holdLifecycleReplies
          ? new Promise<void>((resolve) => lifecycleReplies.push(resolve))
          : Promise.resolve(),
    },
  });
  test('reload retains unconfirmed cancellation and Retry preserves the new draft', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    holdLifecycleReplies = true;
    await requestBox(page).fill('Retry this cancelled request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => lifecycleReplies.length).toBeGreaterThan(0);
    const controls = page.getByRole('region', { name: 'Active run controls', exact: true });
    await controls.getByRole('button', { name: 'Cancel whole run', exact: true }).click();
    await expect(controls).toContainText('Cancellation has not been sent');
    await page.reload();
    const confirmation = page.getByRole('dialog', { name: 'Cancel whole run', exact: true });
    await expect(confirmation).toContainText('Cancellation has not been sent');
    await confirmation
      .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
      .click();
    holdLifecycleReplies = false;
    for (const release of lifecycleReplies.splice(0)) release();
    const retry = page.getByRole('button', { name: 'Retry request', exact: true });
    await expect(retry).toBeEnabled();
    await requestBox(page).fill('Keep my next draft');
    await retry.click();
    await expect(
      page.getByTestId('chat-timeline').getByText('Retry this cancelled request', { exact: true }),
    ).toHaveCount(2);
    await expect(requestBox(page)).toHaveValue('Keep my next draft');
    expect(corral.errors).toEqual([]);
  });
});
