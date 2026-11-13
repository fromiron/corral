import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { type DemoTemplate, templateForWorkspace } from '../../src/demo/templates.ts';
import { approvalResearchTeam } from '../../src/demo/testing/approval-team.ts';
import {
  newConversationFromSidebar,
  openConversationDetails,
  openLibrary,
  openLibraryTeams,
  panelTab,
  requestBox,
  selectSessionTeam,
  showResults,
} from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

const request = requestBox;
const timeline = (page: Page) => page.getByTestId('chat-timeline');

async function openResultsList(page: Page) {
  await panelTab(page, 'Results');
  return page.getByRole('tabpanel', { name: 'Runs', exact: true });
}

async function session(page: Page, corral: Harness, definition = linearCorral(['writer'])) {
  await corral.open('/');
  await openLibraryTeams(page);
  await page.locator('input[type=file]').setInputFiles({
    name: 'usability.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(definition)),
  });
  await expect(page).toHaveURL(/\/edit$/);
  await newConversationFromSidebar(page);
  await expect(page).toHaveURL(/\/sessions\/session_/);
  // a new session starts in auto mode; these journeys run the imported team.
  await selectSessionTeam(page, definition.name);
}

// These assertions concern a saved graph's review loop, not the composer team's chat runtime.
async function graphSession(page: Page, corral: Harness, template: DemoTemplate) {
  await corral.open('/');
  const started = await page.evaluate(async ({ definition }) => {
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
    const { record } = await call('/corrals', { definition });
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
  const project = page.url();
  const details = await openConversationDetails(page);
  await details
    .getByRole('textbox', { name: 'Purpose', exact: true })
    .fill('Keep this purpose through team setup');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await openLibrary(page, 'Templates');
  await page.getByRole('button', { name: 'Edit a copy of Single agent', exact: true }).click();
  await page.getByRole('button', { name: 'Save copy and edit' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  // Back through the library to the project.
  for (let step = 0; step < 4 && page.url() !== project; step++) await page.goBack();
  await expect(page).toHaveURL(project);
  await openConversationDetails(page);
  await expect(details.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue(
    'Keep this purpose through team setup',
  );
  await page.keyboard.press('Escape');
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
  // With saved details the sidebar's New conversation shows them before starting.
  await page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: 'New conversation', exact: true })
    .click();
  await expect(details.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue(
    'Keep this purpose through team setup',
  );
  await details.getByRole('button', { name: 'Start chat', exact: true }).click();
  await committed;
  await expect(details.getByRole('textbox', { name: 'Purpose', exact: true })).toBeDisabled();
  await expect(details.getByRole('combobox', { name: 'Corral', exact: true })).toBeDisabled();
  // The details dialog is modal, so settings opens from its shortcut while the start is pending.
  await page.keyboard.press('Control+,');
  await page
    .getByRole('dialog', { name: 'Settings', exact: true })
    .getByRole('link', { name: 'Shortcuts', exact: true })
    .click();
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
  // Nothing to ask about yet: the only choice is a next request, so no intent picker shows.
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
    // The sidebar row names its latest run's state through its mark.
    await expect(
      page.getByTestId('app-sidebar').getByRole('link', { name: /^Draft a release plan Paused/ }),
    ).toBeVisible();
    // While a run is active Send joins it: the instruction is read at its next model request
    // (composer-flow.md "전송").
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
    // Every version of the run is checked in its Results view, which takes longer.
    test.setTimeout(60_000);
    const template = templateForWorkspace('research-team', 'audit_team');
    const { runId } = await graphSession(page, corral, template);
    await expect(timeline(page).getByTestId('run-ended')).toBeVisible({ timeout: 20000 });
    const projection = corral.server.coordinator.getSnapshot(runId).projection;
    expect(Object.keys(projection.reviews).length).toBeGreaterThan(0);
    await expect(timeline(page).getByTestId('run-ended')).toContainText('failed');
    await expect(timeline(page).getByTestId('run-ended')).toHaveAttribute('role', 'note');
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
    const partial = panel.getByRole('button', { name: /^Partial results / });
    // Each partial result the session lists is named `{name} vN · Run #1 · {step} · execution N`.
    const listed = (
      await partial.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute('aria-label') ?? ''),
      )
    ).map((label) => {
      const artifact = Object.values(projection.artifacts).find(
        (item) =>
          label.startsWith(`Partial results ${item.name} v${item.version} · `) &&
          label.endsWith(
            ` · execution ${projection.executionOrder.indexOf(item.authorExecutionId) + 1}`,
          ),
      );
      if (!artifact) throw new Error(`The listed partial result ${label} is not in the run`);
      return artifact;
    });
    expect(listed.length).toBeGreaterThan(0);
    await partial.first().click();
    const monitor = page.getByTestId('run-monitor');
    // Product gap: the list opens a partial result in the final-result reader, which says it
    // cannot be loaded (partial results open as the artifact they are). Soft, so the run's own
    // list of every version below is still checked.
    await expect.soft(monitor.getByText('This result could not be loaded.')).toHaveCount(0);
    await monitor.getByRole('button', { name: 'Back to work', exact: true }).click();
    // The run's Results view lists every version with the execution that made it.
    const versions = await showResults(page);
    const definition = corral.server.coordinator.getRunSnapshot(runId)?.definition;
    for (const artifact of Object.values(projection.artifacts)) {
      const execution = projection.executions[artifact.authorExecutionId];
      const row = versions.locator(`[data-result-version="${artifact.artifactVersionId}"]`);
      await expect(row).toContainText(artifact.name);
      await expect(row).toContainText(`v${artifact.version}`);
      await expect(row).toContainText(
        definition?.nodes.find((node) => node.id === execution?.nodeId)?.label ?? '',
      );
      await expect(row).toContainText(`Attempt ${execution?.attemptNo}`);
    }
    // Every partial result the session listed opens from there.
    for (const artifact of listed) {
      const open = versions
        .locator(`[data-result-version="${artifact.artifactVersionId}"]`)
        .getByRole('button', { name: `${artifact.name} v${artifact.version}`, exact: true });
      // Product gap: the session list also offers a partial result whose text the run no
      // longer keeps (only each step's last submission is kept, api-contract.md 산출물 본문 수명).
      await expect.soft(open).toHaveCount(1);
      if (!(await open.count())) continue;
      await open.click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('artifact'))
        .toBe(artifact.artifactVersionId);
      await expect(
        monitor.getByRole('region', {
          name: `${artifact.name} · Version ${artifact.version}`,
          exact: true,
        }),
      ).toBeVisible();
      await monitor.getByRole('button', { name: 'Back to work', exact: true }).click();
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
    // Run cards are named by their number in the session; a new run is said only in the
    // request box's description.
    await expect(
      timeline(page).getByRole('region', { name: `Run #${index + 1}`, exact: true }),
    ).toContainText('Succeeded');
    await expect(request(page)).toHaveAccessibleDescription(
      'Send to: new run in this session · next request',
    );
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
  await graphSession(page, corral, approvalResearchTeam('approval_team'));
  const sessionUrl = new URL(page.url()).pathname;
  // The conversation offers approval inline; opening history exposes only its own form.
  await expect(timeline(page).locator('[data-testid^="approval-"]')).toBeVisible({
    timeout: 15000,
  });
  // The top bar's waiting pill is the way to the run's response area (the composer has no
  // notice for an approval its turn already shows).
  const pill = page.getByRole('banner').getByTestId('dock-open-active-run');
  await expect(pill).toHaveAttribute('data-state', 'waiting');
  await pill.click();
  const observer = page.getByTestId('run-monitor');
  const decision = observer
    .locator('[data-testid^="approval-"]')
    .filter({ hasText: 'Your decision' });
  await expect(decision).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Continue with this version' })).toHaveCount(1);
  await expect(timeline(page).locator('[data-testid^="approval-"]')).toBeHidden();
  await expect(
    page
      .getByTestId('app-sidebar')
      // The row's mark names the state; its words are the time alone.
      .getByRole('link', { name: /^Review the release plan Waiting for you/ }),
  ).toBeVisible();
  await decision.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(sessionUrl);
  await expect(
    observer.getByRole('region', { name: 'draft · Version 2', exact: true }),
  ).toBeVisible();
  // A version opens as a document over the work; versions other than final results are
  // listed in the run's Results view behind it.
  await observer.getByRole('button', { name: 'Back to work', exact: true }).click();
  await (await showResults(page)).getByRole('button', { name: 'review v2', exact: true }).click();
  await expect(
    observer.getByRole('region', { name: 'review · Version 2', exact: true }),
  ).toBeVisible();
  await observer.getByRole('button', { name: 'Back to work', exact: true }).click();
  await decision.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect(
    observer.getByRole('region', { name: 'draft · Version 2', exact: true }),
  ).toBeVisible();
  // An open document covers the response area (workbench.md: a respond link closes "가리는
  // 문서"), so the decision is made back at the work.
  await expect(decision).toBeHidden();
  await observer.getByRole('button', { name: 'Back to work', exact: true }).click();
  await decision.getByRole('button', { name: 'Continue with this version' }).click();
  const final = observer.locator('[data-testid^="approval-"]').filter({ hasText: 'Final output' });
  await expect(final).toBeVisible();
  await final.getByRole('button', { name: 'Confirm as final result' }).click();
  await panelTab(page, 'Conversation');
  await expect(timeline(page).getByText('Succeeded').first()).toBeVisible();
  expect(corral.errors).toEqual([]);
});
