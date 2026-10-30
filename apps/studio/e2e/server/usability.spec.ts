import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { type DemoTemplate, templateForWorkspace } from '../../src/demo/templates.ts';
import { panelTab, requestBox, selectSessionTeam } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

const request = requestBox;
const timeline = (page: Page) => page.getByTestId('chat-timeline');

async function openResultsList(page: Page) {
  await panelTab(page, 'Results');
  return page.getByRole('tabpanel', { name: 'Execution history', exact: true });
}

async function session(page: Page, corral: Harness, definition = linearCorral(['writer'])) {
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'usability.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(definition)),
  });
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('link', { name: 'New session', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  // a new session starts in auto mode; these journeys run the imported team.
  await selectSessionTeam(page, definition.name);
}

// These assertions concern a saved graph's review loop, not the composer team's chat runtime.
async function graphSession(page: Page, corral: Harness, template: DemoTemplate) {
  await corral.open('/');
  const started = await page.evaluate(async ({ definition, layout }) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, body: unknown) => {
      const response = await fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`);
      return response.json();
    };
    const { record } = await call('/corrals', { definition, layout });
    const { session } = await call('/sessions', {
      projectId: 'default',
      title: 'Review the release plan',
      corralId: record.corralId,
    });
    const result = await call('/runs', {
      schemaVersion: '0.1',
      commandId: 'usability-saved-graph',
      mode: 'mock',
      sessionId: session.sessionId,
      corralId: record.corralId,
      definitionRevision: record.definitionRevision,
    });
    if (!result.runId) throw new Error('Expected an accepted saved graph start');
    return { sessionId: session.sessionId as string, runId: result.runId as string };
  }, template);
  await corral.open(`/sessions/${started.sessionId}`);
  return started;
}

test('UX-015-01 new-session drafts survive team setup and become an editable first request', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
  await page
    .getByRole('textbox', { name: 'Purpose', exact: true })
    .fill('Keep this purpose through team setup');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Edit this team' })
    .click();
  await page.getByRole('button', { name: 'Save copy and edit' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.goBack();
  if (!(await page.getByRole('textbox', { name: 'Purpose', exact: true }).isVisible()))
    await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
  await expect(page.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue(
    'Keep this purpose through team setup',
  );
  let release!: () => void,
    entered!: () => void,
    creates = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route('**/api/v1/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    creates++;
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({ response });
  });
  const finished = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/sessions') && response.request().method() === 'POST',
  );
  await page.getByRole('link', { name: 'New session', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue(
    'Keep this purpose through team setup',
  );
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await committed;
  await expect(page.getByRole('textbox', { name: 'Purpose', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Corral', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Shortcuts', exact: true }).click();
  release();
  await finished;
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/default$/);
  expect(creates).toBe(1);
  await expect(
    page
      .getByTestId('app-sidebar')
      .getByRole('link', { name: /^Keep this purpose through team setup/ }),
  ).toHaveCount(1);
  await page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: /^Keep this purpose through team setup/ })
    .click();
  await expect(request(page)).toHaveValue('Keep this purpose through team setup');
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  // Nothing to ask about yet: the only choice is a follow-up, so no intent picker shows.
  await expect(page.getByRole('combobox', { name: 'What this is' })).toHaveCount(0);
  await request(page).fill('');
  await page.reload();
  await expect(request(page)).toHaveValue('');
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
});

test.describe('instruction delivery', () => {
  test.use({ replyDelayMs: 900 });
  test('UX-015-02 a queued instruction updates to delivered without leaving the conversation', async ({
    page,
    corral,
  }) => {
    await session(page, corral);
    await request(page).fill('Draft a release plan');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Pause run', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible();
    await expect(timeline(page).getByText('Working…', { exact: true })).toHaveCount(0);
    await expect(
      page.getByTestId('app-sidebar').getByRole('img', { name: 'Paused', exact: true }),
    ).toBeVisible();
    await request(page).fill('Separate verified facts from remaining checks.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const runId = corral.server.coordinator.listRuns()[0]?.runId;
    expect(runId).toBeTruthy();
    const status = () =>
      Object.values(corral.server.coordinator.getSnapshot(runId as string).projection.directives)[0]
        ?.status;
    await expect.poll(status).toBe('queued');
    // The first UI poll must observe queued before the run resumes (the reproduced stale-state bug).
    await expect(page.getByTestId('delivery')).toContainText('Waiting for the next model request');
    await page.getByRole('button', { name: 'Resume run', exact: true }).click();
    await expect.poll(status).toBe('delivered');
    await expect(page.getByTestId('delivery')).toContainText('Included in a model request');
    expect(
      Object.values(corral.server.coordinator.getSnapshot(runId as string).projection.directives),
    ).toHaveLength(1);
  });
});

test.describe('long multi-agent output', () => {
  test.use({
    agentReply: {
      reply: () =>
        `# Release plan\n\n${'long-reference-'.repeat(250)}\n\n${'A recorded result.\n\n'.repeat(80)}`,
      beforeReply: async (_turn, input) => {
        if (input.nodeId === 'write' && input.round === 2)
          throw new Error('Fixture writer failed after the first recorded review');
      },
    },
  });
  test('UX-015-03/04/05 failed work exposes its reason, review and every partial result', async ({
    page,
    corral,
  }) => {
    const template = templateForWorkspace('research-team', 'audit_team');
    const { runId } = await graphSession(page, corral, template);
    await expect(
      timeline(page).getByRole('note').filter({ hasText: 'Not finished (Failed)' }),
    ).toBeVisible({ timeout: 20000 });
    const projection = corral.server.coordinator.getSnapshot(runId).projection;
    expect(Object.keys(projection.reviews).length).toBeGreaterThan(0);
    await expect(timeline(page).getByTestId('run-reason')).toContainText('failed');
    await expect(timeline(page).getByTestId('review-verdict')).toContainText(
      'Cite a primary source',
    );
    const bounds = await timeline(page).evaluate((e) => ({
      width: e.clientWidth,
      content: e.scrollWidth,
    }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.width);
    const panel = await openResultsList(page);
    await expect(panel).toContainText('Partial results');
    await expect(panel.getByText('No results yet.')).toHaveCount(0);
    await panel
      .getByRole('button', { name: /^Partial results / })
      .first()
      .click();
    const results = page.getByTestId('run-results');
    for (const summary of await results.locator('details > summary').all()) await summary.click();
    for (const artifact of Object.values(projection.artifacts)) {
      const author = projection.executionOrder.indexOf(artifact.authorExecutionId) + 1;
      await results
        .getByRole('navigation', { name: 'Results', exact: true })
        .getByRole('button')
        .filter({ hasText: `${artifact.name} v${artifact.version}` })
        .filter({ hasText: new RegExp(`execution ${author}(?:\\D|$)`) })
        .click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('result'))
        .toBe(artifact.artifactVersionId);
    }

    // A failed reload must not claim that completed work has no artifacts.
    await panelTab(page, 'Conversation');
    await page.route('**/api/v1/runs/*/snapshot', (route) => route.abort());
    await openResultsList(page);
    await page.reload();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel.getByText('No results yet.')).toHaveCount(0);
    await page.unroute('**/api/v1/runs/*/snapshot');
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(panel).toContainText('Partial results');
  });
});

test('UX-015-04 older results remain reachable after ten runs', async ({ page, corral }) => {
  test.setTimeout(60000);
  await session(page, corral);
  let firstRun = '';
  for (let index = 0; index < 11; index++) {
    const previous = new Set(corral.server.coordinator.listRuns().map((run) => run.runId));
    await request(page).fill(`Result ${index + 1}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(
        () =>
          corral.server.coordinator.listRuns().filter((run) => run.status === 'succeeded').length,
      )
      .toBe(index + 1);
    const completed = corral.server.coordinator.listRuns().find((run) => !previous.has(run.runId));
    if (!completed) throw new Error('Expected the newly completed run');
    if (index === 0) firstRun = completed.runId;
    // Wait for this run in the UI before composing again; a backend completion alone can
    // still leave the composer observing the previous active run and queue the request.
    await expect(
      timeline(page).getByRole('region', { name: completed.runId, exact: true }),
    ).toContainText('Succeeded');
    await expect(
      page.getByText('Send to: new run in this session · follow-up', { exact: true }),
    ).toBeVisible();
  }
  const panel = await openResultsList(page);
  const firstResult = panel.getByRole('button', { name: / · Run #1 · / }).first();
  await expect(firstResult).toHaveCount(0);
  await panel.getByRole('button', { name: 'Show 1 earlier runs' }).click();
  await expect(firstResult).toBeVisible();
  await firstResult.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe(firstRun);
});

test('UX-015-07 approvals name exact versions and keep review inside the session', async ({
  page,
  corral,
}) => {
  await graphSession(page, corral, templateForWorkspace('research-team', 'approval_team'));
  const sessionUrl = new URL(page.url()).pathname;
  // the dock exposes the request; the execution panel owns the one response form.
  await expect(page.getByTestId('action-required')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('action-required').getByRole('link').click();
  const observer = page.getByTestId('run-monitor');
  const decision = observer
    .locator('[data-testid^="approval-"]')
    .filter({ hasText: 'Your decision' });
  await expect(decision).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Continue with this version' })).toHaveCount(1);
  await expect(timeline(page).locator('[data-testid^="approval-"]')).toHaveCount(0);
  await expect(
    page.getByTestId('app-sidebar').getByRole('img', { name: 'Waiting for you', exact: true }),
  ).toBeVisible();
  await decision.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(sessionUrl);
  await expect(
    observer.getByRole('region', { name: 'draft · Version 2', exact: true }),
  ).toBeVisible();
  await observer.getByRole('button', { name: 'review v2', exact: true }).click();
  await expect(
    observer.getByRole('region', { name: 'review · Version 2', exact: true }),
  ).toBeVisible();
  await decision.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect(
    observer.getByRole('region', { name: 'draft · Version 2', exact: true }),
  ).toBeVisible();
  await decision.getByRole('button', { name: 'Continue with this version' }).click();
  const final = observer.locator('[data-testid^="approval-"]').filter({ hasText: 'Final output' });
  await expect(final).toBeVisible();
  await final.getByRole('button', { name: 'Confirm as final result' }).click();
  await panelTab(page, 'Conversation');
  await expect(timeline(page).getByText('Succeeded').first()).toBeVisible();
  expect(corral.errors).toEqual([]);
});
