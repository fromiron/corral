import type { CorralSummary, WorkSession } from '@corral/core';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { requestBox, slash } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

// Use the real browser entry, server, adapter and Coordinator. Only the
// provider response is deterministic; no session, Corral or run is injected.
test.use({ live: true, codexLogin: true, reasoningApi: true });

async function startChat(page: Page, corral: Harness) {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  return new URL(page.url()).pathname;
}

async function session(page: Page): Promise<WorkSession> {
  const id = new URL(page.url()).pathname.split('/').at(-1);
  const response = await page.request.get(new URL(`/api/v1/sessions/${id}`, page.url()).href);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function savedCorrals(page: Page): Promise<CorralSummary[]> {
  const response = await page.request.get(new URL('/api/v1/corrals', page.url()).href);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

// the team for the next turn is a chip in the composer; there are no request options.
const teamChip = (page: Page) =>
  page
    .getByRole('region', { name: 'Request', exact: true })
    .getByRole('combobox', { name: 'Team', exact: true });

async function chooseTeam(page: Page, name: string) {
  await teamChip(page).click();
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
  await expect(teamChip(page)).toContainText(name);
}

test('a default chat starts with no team, one conversation turn and keeps its answer after reload', async ({
  page,
  corral,
}) => {
  const path = await startChat(page, corral);
  expect(await savedCorrals(page)).toEqual([]);
  expect((await session(page)).corralId).toBeNull();
  expect((await session(page)).autoTitle).toBe(true);

  await expect(page.getByRole('button', { name: 'Request options', exact: true })).toHaveCount(0);
  await expect(teamChip(page)).toContainText('No team');
  await expect(page.getByRole('button', { name: 'Attachments', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Model', exact: true })).not.toContainText(
    'Keep existing behavior (unset)',
  );
  await expect(
    page.getByRole('combobox', { name: 'Permissions for next request', exact: true }),
  ).toContainText('Default policy');
  await expect(page.getByRole('button', { name: 'Live voice', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  for (const label of ['Quality preset', 'Verification scope', 'Work style for next request']) {
    await expect(page.getByRole('combobox', { name: label, exact: true })).toBeHidden();
  }
  await expect(
    page.getByRole('switch', { name: 'Review only · no file changes', exact: true }),
  ).toBeHidden();
  await expect(page.getByRole('button', { name: 'Templates', exact: true })).toBeHidden();
  await expect(
    page.getByRole('combobox', {
      name: 'Attach project instructions or memory to this request',
      exact: true,
    }),
  ).toBeHidden();

  await expect(requestBox(page)).toBeInViewport();

  corral.fake?.answerWith('Start by writing what you want to accomplish.');
  const prompt = 'How do I start a normal conversation?';
  await requestBox(page).fill(prompt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  await expect(page.getByTestId('chat-result')).toContainText(
    'Start by writing what you want to accomplish.',
  );
  await expect.poll(async () => (await session(page)).entries[0]?.state).toBe('started');
  const persisted = await session(page);
  expect(persisted).toMatchObject({ title: prompt, autoTitle: false });
  await expect(
    page.getByRole('navigation', { name: 'Projects and sessions', exact: true }),
  ).toContainText(prompt);
  await expect(page.getByRole('navigation', { name: 'Session tabs', exact: true })).toContainText(
    prompt,
  );
  expect(persisted.corralId).toBeNull();
  expect(persisted.entries[0]).toMatchObject({ text: prompt, state: 'started', intent: 'next' });
  const run = corral.server.coordinator.listRuns()[0];
  expect(persisted.entries[0]?.runId).toBe(run?.runId);
  // One lead answers directly: no auto choice, no write/submit round trip.
  const snapshot = run ? corral.server.coordinator.getRunSnapshot(run.runId) : null;
  expect(snapshot?.autoRoute ?? null).toBeNull();
  expect(snapshot?.definition.roles.map((role) => role.name)).toEqual(['Assistant', 'Helper']);
  expect(
    run ? corral.server.coordinator.getSnapshot(run.runId).projection.budget.modelCalls : 0,
  ).toBe(1);
  expect(await savedCorrals(page)).toEqual([]);

  // Reload keeps both the session identity and explicit conversation intent (compose=true).
  const beforeReload = new URL(page.url());
  expect(beforeReload.pathname).toBe(path);
  await page.reload();
  await expect(page).toHaveURL(beforeReload.href);
  await expect(page.getByTestId('chat-timeline')).toContainText(prompt);
  expect((await session(page)).title).toBe(prompt);
  await expect(page.getByTestId('chat-result')).toContainText(
    'Start by writing what you want to accomplish.',
  );
  await expect(requestBox(page)).toBeInViewport();
  expect(corral.errors).toEqual([]);
});

test('the auto team survives reload and gives the lead its roster for the next turn', async ({
  page,
  corral,
}) => {
  await startChat(page, corral);
  await requestBox(page).fill('Plan and review the launch checklist.');
  await chooseTeam(page, 'auto');
  await page.reload();
  await expect(requestBox(page)).toHaveValue('Plan and review the launch checklist.');
  await expect(teamChip(page)).toContainText('auto');
  await page.setViewportSize({ width: 390, height: 844 });
  await teamChip(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: /^No team/ })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(teamChip(page)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  corral.fake?.answerWith('The checklist is planned and reviewed.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  const run = corral.server.coordinator.listRuns()[0];
  if (!run) throw new Error('The request must reach the Coordinator');
  const definition = corral.server.coordinator.getRunSnapshot(run.runId)?.definition;
  expect(definition?.roles.map((role) => role.name)).toEqual([
    'Assistant',
    'Planner',
    'Researcher',
    'Writer',
    'Reviewer',
  ]);
  await expect(page.getByTestId('chat-result')).toContainText(
    'The checklist is planned and reviewed.',
  );
  expect(await savedCorrals(page)).toEqual([]);
  expect(corral.errors).toEqual([]);
});

test('a saved Corral is an optional choice that can be cleared back to a normal chat', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .getByRole('region', { name: 'Start from a template', exact: true })
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Edit this team', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save copy and edit' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  const saved = await savedCorrals(page);
  expect(saved).toHaveLength(1);
  const custom = saved[0];
  if (!custom) throw new Error('Creating a Corral from the template must persist it');
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  expect((await session(page)).corralId).toBeNull();

  await chooseTeam(page, custom.name);
  await expect.poll(async () => (await session(page)).corralId).toBe(custom.corralId);
  await page.reload();
  await expect(teamChip(page)).toContainText(custom.name);
  expect((await session(page)).corralId).toBe(custom.corralId);
  await chooseTeam(page, 'No team');
  await expect.poll(async () => (await session(page)).corralId).toBeNull();
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();

  corral.fake?.answerWith('You can continue without selecting a Corral.');
  await requestBox(page).fill('Continue as a normal chat.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  const run = corral.server.coordinator.listRuns()[0];
  if (!run) throw new Error('The default chat must create a run');
  expect(corral.server.coordinator.getRunSnapshot(run.runId)?.definition.roles[0]?.name).toBe(
    'Assistant',
  );
  expect(await savedCorrals(page)).toEqual(saved);
  await expect(page.getByTestId('chat-result')).toContainText(
    'You can continue without selecting a Corral.',
  );
  expect(corral.errors).toEqual([]);
});

test('a request typed while the lead waits is queued, not started', async ({ page, corral }) => {
  await startChat(page, corral);
  corral.fake?.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('ask_user', {
          key: 'continue',
          questions: [{ id: 'continue', kind: 'text', prompt: 'What should I review next?' }],
        }),
      ],
      { stopReason: 'toolUse' },
    ),
  ]);
  await requestBox(page).fill('Ask me before continuing with this review.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('awaiting_user');
  await expect(page.getByTestId('action-required')).toBeVisible();
  await slash(page, 'queue');
  const draft = 'Keep this queued request while I decide the next step.';
  await requestBox(page).fill(draft);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute(
    'aria-description',
    'Send · Queue as next task',
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(async () => (await session(page)).entries.at(-1))
    .toMatchObject({ text: draft, state: 'queued', intent: 'queue' });
  expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  expect(corral.errors).toEqual([]);
});
