import definition from '../../../../examples/research-brief.corral.json' with { type: 'json' };
import approvalDefinition from '../../../../examples/research-team.corral.json' with {
  type: 'json',
};
import { newConversation, openResult, panelTab, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

async function startRun(
  page: import('@playwright/test').Page,
  corral: { open(path?: string): Promise<void> },
  fixture: { definition: unknown } = { definition },
) {
  await corral.open('/');
  return page.evaluate(async ({ definition }) => {
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
    const saved = await call('/corrals', { definition });
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
    return {
      runId: started.runId as string,
      sessionId: session.sessionId as string,
      corralId: saved.record.corralId as string,
      definitionRevision: saved.record.definitionRevision as number,
    };
  }, fixture);
}

async function finishedRun(
  page: import('@playwright/test').Page,
  corral: { open(path?: string): Promise<void> },
) {
  const { runId, sessionId } = await startRun(page, corral);
  await corral.open(`/runs/${runId}`);
  // A session's run opens in that session's run history.
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}\\?.*run=${runId}`));
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await expect(page.getByRole('group', { name: 'Run graph', exact: true })).toBeVisible();
  await expect(page.getByTestId('run-side')).toBeHidden();
  return `/runs/${runId}`;
}

test('a run completed behind conversation fits its graph when opened and then preserves the chosen zoom', async ({
  page,
  corral,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const started = await startRun(page, corral);
  await expect
    .poll(() => corral.server.coordinator.getSnapshot(started.runId).projection.status)
    .toBe('succeeded');
  // The run workspace may already exist behind the active conversation tab.
  await corral.open(`/sessions/${started.sessionId}`);
  await expect(page.getByRole('tab', { name: 'Conversation', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await panelTab(page, 'Runs');
  const graph = page.getByRole('group', { name: 'Run graph', exact: true });
  await expect(graph).toBeVisible();
  await panelTab(page, 'Conversation');
  const nextRunId = await page.evaluate(async ({ sessionId, corralId, definitionRevision }) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const response = await fetch('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        schemaVersion: '0.1',
        commandId: 'run-page-hidden-graph-fit',
        sessionId,
        corralId,
        definitionRevision,
        mode: 'mock',
      }),
    });
    if (!response.ok) throw new Error(`run setup: ${response.status}`);
    return (await response.json()).runId as string;
  }, started);
  await expect
    .poll(() => corral.server.coordinator.getSnapshot(nextRunId).projection.status)
    .toBe('succeeded');
  // The composer says it is the last run; the turn's link carries its number.
  await expect(page.getByTestId('composer-status-pills')).toContainText('Last run');
  await expect(page.getByTestId('turn-run').last()).toHaveText('Run #2');
  await expect(graph).toBeHidden();
  await panelTab(page, 'Runs');
  await expect(page.getByRole('banner').getByRole('button', { name: /Run #2/ })).toBeVisible();
  await expect(graph).toBeVisible();
  await expect
    .poll(() =>
      graph.evaluate((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        const viewport = canvas.querySelector('[data-graph-stage]');
        const nodes = [...canvas.querySelectorAll('[data-agent-id] [data-run-status]')].map(
          (node) => node.getBoundingClientRect(),
        );
        if (!viewport || !nodes.length) return false;
        const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).m11;
        // A hidden, zero-size first fit leaves the graph at its minimum scale. Small graphs
        // may legitimately fit at maxZoom=1 without occupying half of a large canvas.
        return (
          zoom > 0.25 &&
          nodes.every(
            (node) =>
              node.width > 40 &&
              node.height > 20 &&
              node.left >= bounds.left - 2 &&
              node.right <= bounds.right + 2 &&
              node.top >= bounds.top - 2 &&
              node.bottom <= bounds.bottom + 2,
          )
        );
      }),
    )
    .toBe(true);
  const viewport = graph.locator('[data-graph-stage]');
  const initial = await viewport.getAttribute('style');
  await graph.getByRole('button', { name: /^zoom in$/i }).click();
  await expect(viewport).not.toHaveAttribute('style', initial ?? '');
  const preferred = await viewport.getAttribute('style');
  await panelTab(page, 'Conversation');
  await expect(graph).toBeHidden();
  await panelTab(page, 'Runs');
  await expect(graph).toBeVisible();
  await expect(viewport).toHaveAttribute('style', preferred ?? '');
  expect(corral.errors).toEqual([]);
});

test('live event counts keep event filters, selection and scroll in the primary workspace', async ({
  page,
  corral,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const { runId } = await startRun(page, corral, { definition: approvalDefinition });
  await corral.open(`/runs/${runId}`);
  // The run waits; its record reads the request beside the conversation, whose tray answers it.
  await expect(page.getByTestId('run-side').getByTestId('respond-in-conversation')).toBeVisible({
    timeout: 30_000,
  });
  // The decision comes from elsewhere (another client), so events arrive while this view stays.
  const approve = () =>
    page.evaluate(
      async ({ runId, approval }) => {
        const { csrfToken } = await (await fetch('/api/v1/session')).json();
        const response = await fetch(`/api/v1/runs/${runId}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify({
            schemaVersion: '0.1',
            commandId: 'live-events-approval',
            runId,
            type: 'resolve_approval',
            expectedControlRevision: approval.controlRevision,
            payload: {
              approvalId: approval.approvalId,
              decision: 'approve',
              subjectVersionId: approval.subjectVersionId,
            },
          }),
        });
        if (!response.ok) throw new Error(`approve: ${response.status}`);
      },
      (() => {
        const { projection } = corral.server.coordinator.getSnapshot(runId);
        const waiting = Object.values(projection.approvals).find(
          (item) => item.status === 'pending',
        );
        if (!waiting) throw new Error('no waiting approval');
        return {
          runId,
          approval: {
            approvalId: waiting.approvalId,
            subjectVersionId: waiting.subjectVersionIds[0] ?? '',
            controlRevision: projection.controlRevision,
          },
        };
      })(),
    );
  const monitor = page.getByTestId('run-monitor');
  const tab = monitor.getByRole('tab', { name: /^Events \d+$/ });
  await tab.click();
  const events = monitor.locator('[data-run-workspace-view="events"]');
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
  await approve();
  await expect(tab).not.toHaveText(count ?? '');
  await expect(kind).toContainText('tool');
  await expect(selected).toHaveText(selectedText ?? '');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(top);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: test.info().outputPath('run-workspace-live-events.png') });
  expect(corral.errors).toEqual([]);
});

test('switching workspace views and reading a result preserves selection, scroll and graph state', async ({
  page,
  corral,
}) => {
  await page.setViewportSize({ width: 1600, height: 500 });
  await finishedRun(page, corral);
  const monitor = page.getByTestId('run-monitor');
  const views = monitor.getByRole('tablist', { name: 'Execution views', exact: true });
  await views.getByRole('tab', { name: 'Workflow', exact: true }).click();
  const flow = monitor.locator('[data-run-workspace-view="flow"]');
  await expect(flow.getByRole('tree')).toBeVisible();
  const side = page.getByTestId('run-side');
  await flow
    .getByRole('button', { name: / · exec_/ })
    .first()
    .click();
  await expect(page).toHaveURL(/execution=exec_/);
  const selectedExecution = new URL(page.url()).searchParams.get('execution');
  await monitor.getByRole('button', { name: 'Run info', exact: true }).click();
  await side.getByRole('tab', { name: 'Usage', exact: true }).click();
  await expect
    .poll(() => side.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  const sideBounds = await side.boundingBox();
  if (!sideBounds) throw new Error('The selected execution side panel must be visible');
  // Scroll the panel's padding, not a nested table or log inside it.
  await page.mouse.move(sideBounds.x + sideBounds.width - 4, sideBounds.y + sideBounds.height / 2);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => side.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const sideTop = await side.evaluate((element) => element.scrollTop);
  await flow.hover();
  await page.mouse.wheel(0, 150);
  await expect.poll(() => flow.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const flowTop = await flow.evaluate((element) => element.scrollTop);
  await views.getByRole('tab', { name: /^Events \d+$/ }).click();
  const events = monitor.locator('[data-run-workspace-view="events"]');
  const eventList = events.getByTestId('timeline-scroll');
  await eventList.getByRole('button').first().click();
  const selectedText = await events.getByTestId('timeline-selected').textContent();
  await eventList.hover();
  await page.mouse.wheel(0, 180);
  await expect.poll(() => eventList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const eventTop = await eventList.evaluate((element) => element.scrollTop);

  await views.getByRole('tab', { name: 'Graph', exact: true }).click();
  const graph = monitor.getByRole('group', { name: 'Run graph', exact: true });
  await graph.getByRole('button', { name: /^zoom in$/i }).click();
  const viewport = graph.locator('[data-graph-stage]');
  const transform = await viewport.getAttribute('style');
  await openResult(page);
  const document = monitor.getByTestId('run-document');
  await expect(document.getByTestId('result-body')).toBeVisible();
  await expect(graph).toBeHidden();
  await document.getByRole('button', { name: 'Back to work', exact: true }).click();
  // Back returns to the Results view the result was opened from; the graph kept its state.
  await expect(monitor.locator('[data-run-workspace-view="results"]')).toBeVisible();
  await views.getByRole('tab', { name: 'Graph', exact: true }).click();
  await expect(graph).toBeVisible();
  await expect(viewport).toHaveAttribute('style', transform ?? '');
  await expect.poll(() => side.evaluate((element) => element.scrollTop)).toBe(sideTop);
  await expect(side.getByRole('tab', { name: 'Usage', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await views.getByRole('tab', { name: 'Workflow', exact: true }).click();
  await expect.poll(() => flow.evaluate((element) => element.scrollTop)).toBe(flowTop);
  await expect(
    flow
      .getByRole('treeitem', { selected: true })
      .locator(`[data-execution-id="${selectedExecution}"]`)
      .first(),
  ).toBeVisible();
  await views.getByRole('tab', { name: /^Events \d+$/ }).click();
  await expect.poll(() => eventList.evaluate((element) => element.scrollTop)).toBe(eventTop);
  await expect(events.getByTestId('timeline-selected')).toHaveText(selectedText ?? '');
  await views.getByRole('tab', { name: /^Events \d+$/ }).click();
  await expect(events).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('run-workspace-scroll-preserved.png') });
  expect(corral.errors).toEqual([]);
});

test('a graph preview opens its exact readable result directly and returns to the node', async ({
  page,
  corral,
}) => {
  const runPath = await finishedRun(page, corral);
  const runId = runPath.split('/').at(-1);
  if (!runId) throw new Error('Run ID missing');
  const { projection } = corral.server.coordinator.getSnapshot(runId);
  const artifactId = projection.output?.artifactVersionIds[0];
  const artifact = artifactId ? projection.artifacts[artifactId] : undefined;
  const execution = artifact ? projection.executions[artifact.authorExecutionId] : undefined;
  if (!artifact || !execution) throw new Error('Output artifact and its author are required');
  const monitor = page.getByTestId('run-monitor');
  const side = monitor.getByTestId('run-side');
  await monitor.getByRole('button', { name: 'Run info', exact: true }).click();
  await expect(side.getByRole('heading', { name: 'Run info', exact: true })).toBeVisible();
  const node = monitor
    .getByRole('group', { name: 'Run graph', exact: true })
    .locator(`[data-agent-id="${execution.nodeId}"]`)
    .getByRole('button');
  await node.click();
  await expect(side.getByRole('heading', { name: 'Run info', exact: true })).toBeVisible();
  const row = page.locator(
    `[data-slot="popover-popup"] li[data-execution-id="${execution.executionId}"]`,
  );
  const result = row.getByRole('button', {
    name: `${artifact.name} v${artifact.version}`,
    exact: true,
  });
  await expect(result).toHaveAccessibleDescription(
    new RegExp(
      `Agent execution ${projection.executionOrder.indexOf(execution.executionId) + 1}.*Attempt ${execution.attemptNo}`,
    ),
  );
  await result.click();
  const document = monitor.getByTestId('run-document');
  await expect(document.getByTestId('artifact-viewer')).toBeVisible();
  await expect(document).toBeFocused();
  await expect(side).toBeHidden();
  expect(new URL(page.url()).searchParams.get('artifact')).toBe(artifactId);
  expect(new URL(page.url()).searchParams.get('execution')).toBeNull();
  await document.getByRole('button', { name: 'Back to work', exact: true }).click();
  await expect(node).toBeFocused();
  await expect(side.getByRole('heading', { name: 'Run info', exact: true })).toBeVisible();
  expect(corral.errors).toEqual([]);
});

test.describe('active graph preview', () => {
  let reply = Promise.resolve();
  let releaseReply = () => {};
  test.use({ agentReply: { reply: () => 'Deterministic response', beforeReply: () => reply } });

  test('opens Reins for the chosen execution and keeps its draft when returning to the graph', async ({
    page,
    corral,
  }) => {
    reply = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    try {
      const { runId } = await startRun(page, corral);
      await expect
        .poll(() => corral.server.coordinator.getSnapshot(runId).projection.executionOrder.length)
        .toBeGreaterThan(0);
      const { projection } = corral.server.coordinator.getSnapshot(runId);
      const executionId = projection.executionOrder[0];
      const execution = executionId ? projection.executions[executionId] : undefined;
      if (!executionId || !execution) throw new Error('Active execution missing');
      await corral.open(`/runs/${runId}`);
      const monitor = page.getByTestId('run-monitor');
      const node = monitor
        .getByRole('group', { name: 'Run graph', exact: true })
        .locator(`[data-agent-id="${execution.nodeId}"]`)
        .getByRole('button');
      await node.click();
      const row = page.locator(
        `[data-slot="popover-popup"] li[data-execution-id="${executionId}"]`,
      );
      const steer = row.getByRole('button', { name: 'Give instruction', exact: true });
      await expect(steer).toHaveAccessibleDescription('Agent execution 1 · Attempt 1');
      await steer.click();
      const reins = monitor.getByTestId('run-instructions');
      await expect(reins).toBeVisible();
      // A running execution takes instructions, so focus lands in the instruction box.
      await expect(reins.getByLabel('Instruction', { exact: true })).toBeFocused();
      await expect(reins).toContainText('Agent execution 1');
      await expect(monitor.getByTestId('run-side')).toBeHidden();
      expect(new URL(page.url()).searchParams.get('execution')).toBeNull();
      await reins.getByLabel('Instruction', { exact: true }).fill('Keep this draft');
      await reins.getByRole('button', { name: 'Back to work', exact: true }).click();
      await expect(node).toBeFocused();
      await node.click();
      await row.getByRole('button', { name: 'Give instruction', exact: true }).click();
      await expect(reins.getByLabel('Instruction', { exact: true })).toHaveValue('Keep this draft');
      await expect(reins).toContainText('Agent execution 1');
      expect(corral.errors).toEqual([]);
    } finally {
      releaseReply();
    }
  });
});

test('a reload keeps the chosen execution and its selected agent', async ({ page, corral }) => {
  await finishedRun(page, corral);
  await expect(page.getByText('Layout from the saved team')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Workflow', exact: true }).click();
  await page
    .getByTestId('run-work-flow')
    .getByRole('button', { name: /^Research Helper · exec_/ })
    .first()
    .click();
  await expect(page).toHaveURL(/execution=exec_/);
  const executionId = new URL(page.url()).searchParams.get('execution');
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`execution=${executionId}`));
  await expect(
    page
      .getByRole('group', { name: 'Run graph', exact: true })
      .locator('[data-agent-id="helper"]')
      .getByRole('button'),
  ).toHaveAttribute('aria-pressed', 'true');
  // The side shows the chosen execution again. It has finished, so it offers no instruction:
  // what was sent to it is read in its call conversation (execution-monitor.md: "지시하기는 끝나지
  // 않은 실행에만 제공하며, 끝난 실행에 보냈던 지시와 전달 여부는 그 실행의 호출 대화에서 본다").
  const side = page.getByTestId('run-side');
  await expect(side).toContainText('Research Helper');
  await expect(side.getByRole('button', { name: 'Give instruction', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Instruction', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Workflow', exact: true }).click();
  await expect(
    page
      .getByTestId('run-work-flow')
      .getByRole('treeitem', { selected: true })
      .locator(`[data-execution-id="${executionId}"]`)
      .first(),
  ).toBeVisible();
  expect(corral.errors).toEqual([]);
});

test('a long multiline request keeps graph, events and run information reachable in the viewport', async ({
  page,
  corral,
}) => {
  const started = await startRun(page, corral);
  const request = Array.from({ length: 10 }, (_, index) =>
    `${index + 1}. Review the current layout and explain the findings with concrete examples. `.repeat(
      3,
    ),
  ).join('\n');
  await page.evaluate(
    async ({ runId, sessionId, request }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1/sessions/${sessionId}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({ intent: 'next', text: request, state: 'started', runId }),
      });
      if (!response.ok) throw new Error(`entry setup: ${response.status}`);
    },
    { ...started, request },
  );
  await corral.open(`/sessions/${started.sessionId}?panel=run&run=${started.runId}`);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  const monitor = page.getByTestId('run-monitor');
  const views = monitor.getByRole('tablist', { name: 'Execution views', exact: true });
  const graphTab = views.getByRole('tab', { name: 'Graph', exact: true });
  const eventsTab = views.getByRole('tab', { name: /^Events \d+$/ });
  const info = monitor.getByRole('button', { name: 'Run info', exact: true });
  for (const viewport of [
    { width: 1280, height: 560 },
    { width: 390, height: 664 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(graphTab).toBeInViewport({ ratio: 1 });
    await expect(eventsTab).toBeInViewport({ ratio: 1 });
    await expect(info).toBeInViewport({ ratio: 1 });
    const graph = monitor.getByRole('group', { name: 'Run graph', exact: true });
    // Too narrow for the map's names to read, the graph view starts as its list.
    if (viewport.width < 640) {
      await expect(monitor.getByRole('button', { name: 'List', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(graph.getByRole('table', { name: 'Agents', exact: true })).toBeInViewport();
    } else await expect(graph.getByRole('button', { name: /^zoom in$/i })).toBeInViewport();
    await eventsTab.click();
    await expect(monitor.locator('[data-run-workspace-view="events"]')).toBeVisible();
    await graphTab.click();
    await expect(graph).toBeVisible();
    await info.click();
    const details = page.getByTestId('run-side');
    await expect(details).toBeVisible();
    const close = details.getByRole('button', { name: 'Close details', exact: true });
    await expect(close).toBeInViewport({ ratio: 1 });
    await close.click();
    await expect(graph).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
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
  const side = page.getByTestId('run-side');
  await expect(side.getByRole('button', { name: 'Reins', exact: true })).toHaveCount(0);
  await expect(side.getByRole('button', { name: 'Give instruction', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Instruction', { exact: true })).toHaveCount(0);
});

test('the waiting pill brings the conversation’s needed-now tray into view, even in a narrow window', async ({
  page,
  corral,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const started = await startRun(page, corral, { definition: approvalDefinition });
  await corral.open(`/sessions/${started.sessionId}`);
  // An approval alone is decided in the conversation's tray; the composer has no notice for it,
  // and the top bar's pill (only the run's number at this width) is the way to that tray.
  const pill = page.getByRole('banner').getByTestId('dock-open-active-run');
  await expect(pill).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 });
  await expect(page.getByTestId('action-required')).toHaveCount(0);
  await pill.click();
  // The request to respond opens the conversation, not the run record, and focuses the tray.
  const tray = page.locator('[data-pending-tray]');
  await expect(tray).toBeFocused();
  await expect(tray).toBeInViewport();
  await expect(tray.locator(`[data-run-response="${started.runId}"]`)).toHaveCount(1);
  await expect(page.getByTestId('run-monitor')).toBeHidden();
  // The request is answered once: it does not stay in the address.
  await expect(page).not.toHaveURL(/respond=/);
  expect(corral.errors).toEqual([]);
});

/**
 * The session screen's main area as a person reads it: the top bar and the workbench, without
 * the sidebar and without screen-reader-only text.
 */
function mainText(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const hidden = [...document.querySelectorAll<HTMLElement>('.sr-only')];
    for (const node of hidden) node.style.setProperty('display', 'none', 'important');
    const text = [
      document.querySelector<HTMLElement>('[role="banner"], header'),
      document.querySelector<HTMLElement>('section[aria-label="Workbench layout"]'),
    ]
      .map((node) => node?.innerText ?? '')
      .join('\n');
    for (const node of hidden) node.style.removeProperty('display');
    return text;
  });
}

test('a waiting approval shows its state once (the pill) and its decision once (the card)', async ({
  page,
  corral,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const started = await startRun(page, corral, { definition: approvalDefinition });
  await corral.open(`/sessions/${started.sessionId}`);
  const card = page.locator('[data-testid^="approval-"]');
  await expect(card.getByRole('button', { name: 'Continue with this version' })).toBeVisible({
    timeout: 30_000,
  });
  // The pill names the wait to assistive tech; the run row's head says it in words, once.
  await expect(
    page
      .getByRole('banner')
      .getByTestId('dock-open-active-run')
      .locator('button[data-pill-toggle]'),
  ).toHaveAttribute('aria-label', /Waiting for you/);
  const shown = await mainText(page);
  // "Waiting for you", not the start of "Waiting for your decision".
  expect(shown.match(/Waiting for you(?!r)/g)).toHaveLength(1);
  expect(shown.match(/Your decision/g)).toHaveLength(1);
  expect(shown.match(/Continue with this version/g)).toHaveLength(1);
  expect(shown).not.toContain('Reason:');
  expect(shown).not.toContain('Approval needed');
  await expect(page.getByTestId('action-required')).toHaveCount(0);
  expect(corral.errors).toEqual([]);
});

test('a decision sent from the conversation’s card hands focus on instead of dropping it', async ({
  page,
  corral,
}) => {
  const started = await startRun(page, corral, { definition: approvalDefinition });
  await corral.open(`/sessions/${started.sessionId}`);
  const decide = page
    .locator('[data-testid^="approval-"]')
    .getByRole('button', { name: 'Continue with this version' });
  await expect(decide).toBeVisible({ timeout: 30_000 });
  await decide.focus();
  await page.keyboard.press('Enter');
  await expect(decide).toHaveCount(0);
  // The card left: focus goes to the next waiting card's main action if the final output
  // already waits, else to the request box; never to the page.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return 'page';
        if (active.matches('[data-testid="chat-composer"] textarea')) return 'request';
        if (active.textContent === 'Confirm as final result') return 'final';
        return active.outerHTML.slice(0, 120);
      }),
    )
    .toMatch(/^(request|final)$/);
  expect(corral.errors).toEqual([]);
});

test('ACTION-01 opens one scoped response host and keeps later typing focus', async ({
  page,
  corral,
}) => {
  const started = await startRun(page, corral, { definition: approvalDefinition });
  await corral.open(`/sessions/${started.sessionId}`);
  const action = page.getByTestId('dock-open-active-run');
  await expect(action.locator('button[data-pill-toggle]')).toHaveAttribute(
    'aria-label',
    /Waiting for you/,
  );
  await expect(action).not.toContainText('Respond');
  await action.click();
  // The waiting pill leads to the conversation's needed-now tray, which takes focus.
  const tray = page.locator('[data-pending-tray]');
  await expect(tray).toBeFocused();
  const response = tray.locator('[data-run-response]');
  await expect(page.getByRole('button', { name: 'Continue with this version' })).toHaveCount(1);
  // A subject opens beside the conversation, and the tray keeps the decision.
  await response.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect(
    page.getByTestId('run-monitor').getByRole('region', { name: 'draft · Version 2', exact: true }),
  ).toBeVisible();
  // The run record reads what waits and does not answer it.
  await page
    .getByTestId('run-document')
    .getByRole('button', { name: 'Back to work', exact: true })
    .click();
  await expect(
    page.getByTestId('run-monitor').getByRole('button', { name: 'Continue with this version' }),
  ).toHaveCount(0);
  await panelTab(page, 'Conversation');
  await expect(response).toBeVisible();
  await response.getByRole('button', { name: 'review v2', exact: true }).click();
  await expect(
    page
      .getByTestId('run-monitor')
      .getByRole('region', { name: 'review · Version 2', exact: true }),
  ).toBeVisible();
  await page
    .getByTestId('run-document')
    .getByRole('button', { name: 'Back to work', exact: true })
    .click();
  await panelTab(page, 'Conversation');
  const input = requestBox(page);

  let releaseApproval!: () => void;
  const approvalReady = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });
  await page.route('**/api/v1/runs/*/commands', async (route) => {
    if (route.request().postDataJSON()?.type === 'resolve_approval') await approvalReady;
    await route.continue();
  });
  try {
    const posted = page.waitForRequest(
      (request) =>
        request.url().endsWith('/commands') && request.postDataJSON()?.type === 'resolve_approval',
    );
    await response.getByRole('button', { name: 'Continue with this version' }).click();
    await posted;
    // While the decision waits for its receipt, the person goes on typing.
    await input.fill('Keep typing while the run continues');
    await expect(input).toBeFocused();
    releaseApproval();
    await expect(
      response.getByRole('button', { name: 'Confirm as final result', includeHidden: true }),
    ).toHaveCount(1);
    await expect(action.locator('button[data-pill-toggle]')).toHaveAttribute(
      'aria-label',
      /Waiting for you/,
    );
    await expect(input).toHaveValue('Keep typing while the run continues');
    await expect(input).toBeFocused();
  } finally {
    releaseApproval();
  }
  expect(corral.errors).toEqual([]);
});

test('legacy history links resolve current state, Results Back returns to chat, and graph follows the app theme', async ({
  page,
  corral,
}, testInfo) => {
  const started = await startRun(page, corral);
  await expect
    .poll(() => corral.server.coordinator.getSnapshot(started.runId).projection.status)
    .toBe('succeeded');
  await corral.open(`/sessions/${started.sessionId}?panel=run&run=${started.runId}&atSeq=1`);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await expect(page).not.toHaveURL(/[?&]atSeq=/);
  await expect(page.getByRole('group', { name: 'Run graph', exact: true })).toBeVisible();
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
  const historyTab = page.getByRole('tab', { name: 'Runs', exact: true });
  await expect(historyTab).toBeVisible();
  await historyTab.click();
  const flow = page.getByRole('group', { name: 'Run graph', exact: true });
  await expect(flow).toBeVisible();
  await expect(flow).toHaveCSS('color-scheme', 'dark');
  const node = flow.locator('[data-agent-id="research"]');
  const mark = node.locator('button > div').first();
  await expect(mark).toBeVisible();
  const darkSurface = await mark.evaluate((element) => getComputedStyle(element).backgroundColor);
  const labels = await flow
    .locator('li[data-source][data-target]')
    .evaluateAll((edges) => edges.map((edge) => edge.textContent));
  expect(labels.some((label) => /delegat/i.test(label ?? ''))).toBe(true);
  const selectNode = node.getByRole('button');
  await selectNode.focus();
  await page.keyboard.press('Enter');
  await expect(selectNode).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page
      .locator('[data-slot="popover-popup"]')
      .getByRole('region', { name: 'Research executions' }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('dark-history.png') });
  await page.evaluate(() =>
    localStorage.setItem('corral:workbench:v1', JSON.stringify({ version: 1, theme: 'light' })),
  );
  await page.reload();
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  await expect(flow).toHaveCSS('color-scheme', 'light');
  const lightSurface = await mark.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(lightSurface).not.toBe(darkSurface);
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
      const confirmation = page.getByRole('dialog', { name: 'Cancel whole run', exact: true });
      await expect(confirmation).toHaveCount(1);
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await confirmation
        .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
        .click();
      holdLifecycleReplies = false;
      for (const release of lifecycleReplies.splice(0)) release();
      await expect
        .poll(() => corral.server.coordinator.getSnapshot(target.runId).projection.status)
        .toBe('cancelled');
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        // The steps that went wrong are in the work log the run row's head opens.
        const head = page
          .getByTestId('chat-timeline')
          .locator('[data-chat-part="head"] button[aria-expanded]')
          .last();
        await expect(head).toHaveAttribute('aria-expanded', 'false');
        await head.click();
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
    await newConversation(page);
    holdLifecycleReplies = true;
    await requestBox(page).fill('Retry this cancelled request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => lifecycleReplies.length).toBeGreaterThan(0);
    const controls = page.getByRole('region', { name: 'Active run controls', exact: true });
    await controls.getByRole('button', { name: 'Cancel whole run', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Cancel whole run', exact: true });
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(confirmation).toContainText('Cancellation has not been sent');
    await page.reload();
    await expect(page.getByRole('dialog')).toHaveCount(1);
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
