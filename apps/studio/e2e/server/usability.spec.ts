import type { CorralDefinition } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { templateForWorkspace } from '../../src/demo/templates.ts';
import { panelTab, requestBox } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

const request = requestBox;
const timeline = (page: Page) => page.getByTestId('chat-timeline');

async function session(page: Page, corral: Harness, definition = linearCorral(['writer'])) {
  await corral.open('/');
  await page.locator('input[type=file]').setInputFiles({
    name: 'usability.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(definition)),
  });
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('link', { name: 'New session', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  await expect(page.getByRole('combobox', { name: 'Team', exact: true })).toContainText(
    definition.name,
  );
}

test('[WBTST-004] UX-015-01 new-session drafts survive team setup and become an editable first request', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByText('Session details (optional)', { exact: true }).click();
  await page.getByLabel('Purpose').fill('Keep this purpose through team setup');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Edit this team' })
    .click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.goBack();
  await page.getByText('Session details (optional)', { exact: true }).click();
  await expect(page.getByLabel('Purpose')).toHaveValue('Keep this purpose through team setup');
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
  await committed;
  await expect(page.getByLabel('Purpose')).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Team', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Shortcuts', exact: true }).click();
  release();
  await finished;
  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
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
  test('[WBTST-004] UX-015-02 a queued instruction updates to delivered without leaving the conversation', async ({
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
    await page.waitForTimeout(2300);
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
    agentReply: `# Release plan\n\n${'long-reference-'.repeat(250)}\n\n${'A recorded result.\n\n'.repeat(80)}`,
  });
  test('[WBTST-004] UX-015-03/04/05 failed work exposes its reason, review and every partial result', async ({
    page,
    corral,
  }) => {
    const definition = templateForWorkspace('research-team', 'audit_team')
      .definition as CorralDefinition;
    definition.limits.maxModelCalls = 12;
    await session(page, corral, definition);
    await request(page).fill('Review this release plan');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      timeline(page).getByRole('note').filter({ hasText: 'Not finished (Failed)' }),
    ).toBeVisible({ timeout: 20000 });
    const runId = corral.server.coordinator.listRuns()[0]?.runId as string;
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
    await panelTab(page, 'Results');
    const panel = page.getByRole('tabpanel', { name: 'Results', exact: true });
    await expect(panel).toContainText('Partial results');
    for (const artifact of Object.values(projection.artifacts))
      await expect(
        panel
          .getByRole('button')
          .filter({ hasText: `${artifact.name} v${artifact.version}` })
          .first(),
      ).toBeVisible();
    await expect(panel.getByText('No results yet.')).toHaveCount(0);

    // A failed reload must not claim that completed work has no artifacts.
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await page.route('**/api/v1/runs/*/snapshot', (route) => route.abort());
    await page.getByRole('tab', { name: 'Results', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel.getByText('No results yet.')).toHaveCount(0);
    await page.unroute('**/api/v1/runs/*/snapshot');
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(panel).toContainText('Partial results');
  });
});

test('[WBTST-004] UX-015-04 older results remain reachable after ten runs', async ({
  page,
  corral,
}) => {
  test.setTimeout(60000);
  await session(page, corral);
  let firstRun = '';
  for (let index = 0; index < 11; index++) {
    await request(page).fill(`Result ${index + 1}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(
        () =>
          corral.server.coordinator.listRuns().filter((run) => run.status === 'succeeded').length,
      )
      .toBe(index + 1);
    if (index === 0) firstRun = corral.server.coordinator.listRuns()[0]?.runId as string;
    await expect(page.getByRole('combobox', { name: 'What this is' })).toContainText('Follow-up');
  }
  await panelTab(page, 'Results');
  const panel = page.getByRole('tabpanel', { name: 'Results', exact: true });
  await expect(panel.getByRole('button').filter({ hasText: firstRun })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Show 1 earlier runs' }).click();
  await expect(panel.getByRole('button').filter({ hasText: firstRun })).toHaveCount(1);
});

test('[WBTST-004] UX-015-07 approvals name exact versions and keep review inside the session', async ({
  page,
  corral,
}) => {
  const definition = templateForWorkspace('research-team', 'approval_team')
    .definition as CorralDefinition;
  await session(page, corral, definition);
  const sessionUrl = new URL(page.url()).pathname;
  await request(page).fill('Review the release plan and request approval.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // The decision shows in the conversation and, while its result is open, beside it (UX-03).
  const decision = timeline(page)
    .locator('[data-testid^="approval-"]')
    .filter({ hasText: 'Your decision' });
  await expect(decision).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByTestId('app-sidebar').getByRole('img', { name: 'Waiting for you', exact: true }),
  ).toBeVisible();
  await decision.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(sessionUrl);
  await expect(page.getByRole('article', { name: 'draft v2', exact: true })).toBeVisible();
  const observer = page.getByRole('tabpanel', { name: 'Execution', exact: true });
  await observer.getByRole('button', { name: 'review v2', exact: true }).click();
  await expect(
    observer.getByRole('region', { name: 'review · Version 2', exact: true }),
  ).toBeVisible();
  await decision.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect(observer.getByRole('article', { name: 'draft v2', exact: true })).toBeVisible();
  await decision.getByRole('button', { name: 'Continue with this version' }).click();
  const final = timeline(page)
    .locator('[data-testid^="approval-"]')
    .filter({ hasText: 'Final output' });
  await expect(final).toBeVisible();
  await final.getByRole('button', { name: 'Confirm as final result' }).click();
  await expect(timeline(page).getByText('Succeeded').first()).toBeVisible();
  expect(corral.errors).toEqual([]);
});
