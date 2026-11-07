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
  await expect(page.getByTestId('run-activity')).toBeVisible();
  return new URL(page.url()).pathname;
}

test('live event counts keep event filters, selection and scroll in the dock', async ({
  page,
  corral,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const { runId } = await startRun(page, corral, {
    definition: approvalDefinition,
    layout: approvalLayout,
  });
  await corral.open(`/runs/${runId}`);
  const approval = page.getByRole('button', { name: 'Continue with this version', exact: true });
  await expect(approval).toBeVisible();
  const dock = page.getByTestId('run-dock');
  const tab = dock.getByRole('tab', { name: /^Events \d+$/ });
  await tab.click();
  const events = dock.locator('[data-run-dock-panel="events"]');
  const kind = events.getByRole('combobox', { name: 'Kind', exact: true });
  await kind.click();
  await page.getByRole('option', { name: 'tool', exact: true }).click();
  const scroll = events.getByTestId('timeline-scroll');
  await scroll.getByRole('button').first().click();
  const selected = events.getByTestId('timeline-selected');
  const selectedText = await selected.textContent();
  await scroll.hover();
  await page.mouse.wheel(0, 180);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const top = await scroll.evaluate((element) => element.scrollTop);
  const count = await tab.textContent();
  await approval.click();
  await expect(tab).not.toHaveText(count ?? '');
  await expect(kind).toContainText('tool');
  await expect(selected).toHaveText(selectedText ?? '');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(top);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: test.info().outputPath('run-dock-live-events.png') });
  expect(corral.errors).toEqual([]);
});

test('switching and folding dock views preserves the column, side panel and graph', async ({
  page,
  corral,
}) => {
  await page.setViewportSize({ width: 1600, height: 600 });
  await finishedRun(page, corral);
  const monitor = page.getByTestId('run-monitor');
  const dock = page.getByTestId('run-dock');
  const column = page.getByTestId('run-column-scroll');
  const side = page.getByTestId('run-side');
  await monitor.getByTestId('run-activity').locator('button[data-execution-id]').first().click();
  await side.getByRole('tab', { name: 'Usage', exact: true }).click();
  await expect
    .poll(() => side.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  const sideBounds = await side.boundingBox();
  if (!sideBounds) throw new Error('The default side panel must be visible');
  // Scroll the panel's padding, not a nested table or log inside it.
  await page.mouse.move(sideBounds.x + sideBounds.width - 4, sideBounds.y + sideBounds.height / 2);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => side.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const sideTop = await side.evaluate((element) => element.scrollTop);
  await dock.getByRole('tab', { name: /^Events \d+$/ }).click();
  const events = dock.locator('[data-run-dock-panel="events"]');
  await events.focus();
  await page.keyboard.press('End');
  await expect
    .poll(() =>
      events.evaluate(
        (element) =>
          element.scrollTop > 0 &&
          Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight)) < 1,
      ),
    )
    .toBe(true);
  const eventTop = await events.evaluate((element) => element.scrollTop);
  await column.hover();
  await page.mouse.wheel(0, 150);
  await expect.poll(() => column.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const columnTop = await column.evaluate((element) => element.scrollTop);

  await dock.getByRole('tab', { name: 'Graph', exact: true }).click();
  const graph = monitor.getByRole('application', { name: 'Run graph', exact: true });
  await graph.getByRole('button', { name: /^zoom in$/i }).click();
  const viewport = graph.locator('.react-flow__viewport');
  const transform = await viewport.getAttribute('style');
  await dock.getByRole('tab', { name: /^Events \d+$/ }).click();
  await expect.poll(() => events.evaluate((element) => element.scrollTop)).toBe(eventTop);
  await dock.getByRole('tab', { name: /^Events \d+$/ }).click();
  await expect(dock.locator('[data-run-dock-content]')).toBeHidden();
  await dock.getByRole('tab', { name: /^Events \d+$/ }).click();
  await expect.poll(() => events.evaluate((element) => element.scrollTop)).toBe(eventTop);
  await dock.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(viewport).toHaveAttribute('style', transform ?? '');
  await expect.poll(() => column.evaluate((element) => element.scrollTop)).toBe(columnTop);
  await expect.poll(() => side.evaluate((element) => element.scrollTop)).toBe(sideTop);
  await expect(side.getByRole('tab', { name: 'Usage', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.screenshot({ path: test.info().outputPath('run-dock-scroll-preserved.png') });
  expect(corral.errors).toEqual([]);
});

test('a reload keeps the chosen execution and the saved layout', async ({ page, corral }) => {
  await finishedRun(page, corral);
  await page.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(page.getByText('Layout from the saved team')).toBeVisible();
  await page
    .getByTestId('run-activity')
    .getByRole('button', { name: /^Research Helper\b/ })
    .first()
    .click();
  await expect(page).toHaveURL(/execution=exec_/);
  const executionId = new URL(page.url()).searchParams.get('execution');
  await page.reload();
  await page.getByTestId('run-monitor').getByRole('tab', { name: 'Reins', exact: true }).click();
  const reins = page.getByRole('region', { name: 'Reins', exact: true });
  await expect(reins).toContainText(`execution ${executionId}`);
  await expect(
    page.getByTestId('run-activity').locator(`button[data-execution-id="${executionId}"]`),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(corral.errors).toEqual([]);
});

test('an old view-point link opens current state without selecting a missing execution', async ({
  page,
  corral,
}) => {
  const runPath = await finishedRun(page, corral);
  await corral.open(`${runPath}?execution=exec_9999&atSeq=1`);
  await expect(page).not.toHaveURL(/[?&]atSeq=/);
  await expect(page).toHaveURL(/execution=exec_9999/);
  await expect(
    page.getByTestId('run-monitor').getByRole('slider', { name: 'View point' }),
  ).toHaveCount(0);
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
  test('cancelling a run explains its waiting tool as cancelled, including after reload', async ({
    page,
    corral,
  }) => {
    holdLifecycleReplies = true;
    try {
      const target = await startRun(page, corral);
      await page.evaluate(async ({ runId, sessionId }) => {
        const { csrfToken } = await (await fetch('/api/v1/session')).json();
        const response = await fetch(`/api/v1/sessions/${sessionId}/entries`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify({
            intent: 'next',
            text: 'Cancel the waiting team',
            state: 'started',
            runId,
          }),
        });
        if (!response.ok) throw new Error(`entry setup: ${response.status}`);
      }, target);
      await expect
        .poll(() =>
          Object.values(
            corral.server.coordinator.getSnapshot(target.runId).projection.toolCalls,
          ).some((tool) => tool.name === 'await_tasks'),
        )
        .toBe(true);
      await corral.open(`/sessions/${target.sessionId}`);
      await page
        .getByRole('region', { name: 'Active run controls', exact: true })
        .getByRole('button', { name: 'Cancel whole run', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Cancel whole run', exact: true })
        .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
        .click();
      holdLifecycleReplies = false;
      for (const release of lifecycleReplies.splice(0)) release();
      await expect
        .poll(() => corral.server.coordinator.getSnapshot(target.runId).projection.status)
        .toBe('cancelled');
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        const tool = page
          .getByTestId('chat-timeline')
          .locator('li > code')
          .filter({ hasText: /^await_tasks$/ })
          .locator('..');
        await expect(tool.getByText('This step was cancelled.', { exact: true })).toBeVisible();
        await expect(tool).not.toContainText('This step failed.');
        await expect(tool.locator('details')).not.toHaveAttribute('open');
        await tool.getByText('Diagnostics', { exact: true }).click();
        await expect(tool.locator('details code')).toHaveText('scope cancelled');
      }
      const waiting = Object.values(
        corral.server.coordinator.getSnapshot(target.runId).projection.toolCalls,
      ).find((tool) => tool.name === 'await_tasks');
      if (!waiting) throw new Error('The waiting tool is missing');
      await page.goto(
        `${corral.server.url}/sessions/${target.sessionId}?panel=run&run=${target.runId}&view=run&execution=${waiting.executionId}`,
      );
      await expect(page.getByTestId('run-monitor')).toBeVisible();
      await expect(page.getByTestId(`failed-step-${waiting.toolCallId}`)).toHaveCount(0);
      expect(corral.errors).toEqual([]);
    } finally {
      holdLifecycleReplies = false;
      for (const release of lifecycleReplies.splice(0)) release();
    }
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
