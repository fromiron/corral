import type { CorralDefinition } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { templateForWorkspace } from '../../src/demo/templates.ts';
import { expect, type Harness, test } from './harness.ts';

const request = (page: Page) => page.getByRole('textbox', { name: 'Request', exact: true });
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
  await page.getByLabel('Purpose').fill('Review the release plan');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
}

test('[WBTST-004] UX-015-01 new-session drafts survive team setup and become an editable first request', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('link', { name: 'New session', exact: true }).click();
  await page.getByLabel('Purpose').fill('Keep this purpose through team setup');
  await page.getByLabel('Title (optional)').fill('Release planning');
  await page
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Use this template' })
    .click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('link', { name: 'New session', exact: true }).click();
  await expect(page.getByLabel('Purpose')).toHaveValue('Keep this purpose through team setup');
  await expect(page.getByLabel('Title (optional)')).toHaveValue('Release planning');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(request(page)).toHaveValue('Keep this purpose through team setup');
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  await expect(page.getByRole('radio', { name: 'Question about the result' })).toHaveCount(0);
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
      page.getByTestId('app-sidebar').getByText('Paused', { exact: true }),
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
    await page.getByRole('tab', { name: 'Results', exact: true }).click();
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
    await expect(
      page.getByRole('radio', { name: 'Continue in this session', exact: true }),
    ).toBeVisible();
  }
  await page.getByRole('tab', { name: 'Results', exact: true }).click();
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
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const decision = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Your decision' });
  await expect(decision).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByTestId('app-sidebar').getByText('Waiting for you', { exact: true }),
  ).toBeVisible();
  await decision.getByRole('button', { name: 'draft v2', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(sessionUrl);
  await expect(page.getByRole('article', { name: 'draft v2', exact: true })).toBeVisible();
  await page
    .getByRole('tablist', { name: 'Session view' })
    .getByRole('tab', { name: 'Work', exact: true })
    .click();
  await decision.getByRole('button', { name: 'Approve', exact: true }).click();
  const final = page.locator('[data-testid^="approval-"]').filter({ hasText: 'Final output' });
  await expect(final).toBeVisible();
  await final.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(timeline(page).getByText('Succeeded').first()).toBeVisible();
  expect(corral.errors).toEqual([]);
});

test.describe('late result content', () => {
  test.use({
    agentReply: `# Long result\n\n${'Reading an earlier paragraph should keep its place.\n\n'.repeat(140)}`,
  });
  test('[TC-UX-001-H] UX-015-06 a delayed artifact does not discard the conversation reading position', async ({
    page,
    corral,
  }) => {
    await session(page, corral);
    await request(page).fill('Create a long note');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(timeline(page).getByRole('heading', { name: 'Long result' })).toBeVisible();
    await expect(timeline(page).getByText('Succeeded').first()).toBeVisible();
    await timeline(page).evaluate((e) => {
      e.scrollTop = 1100;
    });
    const before = await timeline(page).evaluate((e) => e.scrollTop);
    expect(before).toBeGreaterThan(500);
    await page.route('**/api/v1/runs/*/artifacts/*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await page.getByRole('tab', { name: 'Team design', exact: true }).click();
    await page
      .getByRole('tablist', { name: 'Session view' })
      .getByRole('tab', { name: 'Work', exact: true })
      .click();
    await expect(timeline(page).getByRole('heading', { name: 'Long result' })).toBeVisible();
    await expect.poll(() => timeline(page).evaluate((e) => e.scrollTop)).toBeCloseTo(before, 0);
    await page.reload();
    await expect(timeline(page).getByRole('heading', { name: 'Long result' })).toBeVisible();
    await expect.poll(() => timeline(page).evaluate((e) => e.scrollTop)).toBeCloseTo(before, 0);
    expect(corral.errors).toEqual([]);
  });
});
