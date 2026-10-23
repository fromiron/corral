import type { CorralSummary, WorkSession } from '@corral/core';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { requestBox, slash } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

// CR-043: use the real browser entry, server, adapter and Coordinator. Only the
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

const optionsButton = (page: Page) =>
  page.getByRole('button', { name: 'Request options', exact: true });
const optionsDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Request options', exact: true });

test('[TC-UX-005-H] a default chat starts without a saved Corral or advanced choices and keeps its answer after reload', async ({
  page,
  corral,
}) => {
  const path = await startChat(page, corral);
  expect(await savedCorrals(page)).toEqual([]);
  expect((await session(page)).corralId).toBeNull();
  expect((await session(page)).autoTitle).toBe(true);

  await expect(optionsButton(page)).toBeVisible();
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
  for (const label of [
    'Quality preset',
    'Verification scope',
    'Corral',
    'Work style for next request',
  ]) {
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

  corral.fake?.answerWith('Start by writing what you want to accomplish.', {
    hostReply: '{"template":"single","reason":"One direct answer is enough"}',
  });
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
  expect(persisted.entries[0]?.runId).toBe(corral.server.coordinator.listRuns()[0]?.runId);
  expect(await savedCorrals(page)).toEqual([]);

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByTestId('chat-timeline')).toContainText(prompt);
  expect((await session(page)).title).toBe(prompt);
  await expect(page.getByTestId('chat-result')).toContainText(
    'Start by writing what you want to accomplish.',
  );
  await expect(requestBox(page)).toBeInViewport();
  expect(corral.errors).toEqual([]);
});

test('[TC-UX-005-N] explicit request scope survives closing options and reload, remains visible and reaches the run', async ({
  page,
  corral,
}) => {
  await startChat(page, corral);
  await requestBox(page).fill('Review the proposed launch without editing files.');
  await optionsButton(page).click();
  const dialog = optionsDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('switch', { name: 'Review only · no file changes', exact: true }).check();
  await dialog.getByRole('combobox', { name: 'Verification scope', exact: true }).click();
  await page.getByRole('option', { name: 'Release checks', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(optionsButton(page)).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Review only · no file changes', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release checks', exact: true })).toBeVisible();

  await page.reload();
  await expect(requestBox(page)).toHaveValue('Review the proposed launch without editing files.');
  await expect(
    page.getByRole('button', { name: 'Review only · no file changes', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release checks', exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await optionsButton(page).click();
  await expect(
    dialog.getByRole('switch', { name: 'Review only · no file changes', exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('combobox', { name: 'Verification scope', exact: true }),
  ).toContainText('Release checks');
  await expect(dialog).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(optionsButton(page)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  corral.fake?.answerWith('The proposed launch has been reviewed without file changes.', {
    hostReply: '{"template":"single","reason":"Review the requested scope"}',
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  const run = corral.server.coordinator.listRuns()[0];
  if (!run) throw new Error('The request must reach the Coordinator');
  expect(corral.server.coordinator.getRunSnapshot(run.runId)?.definition.input).toMatchObject({
    taskScope: 'review_only',
    verificationScope: 'release',
  });
  await expect
    .poll(async () => (await session(page)).entries[0])
    .toMatchObject({ taskScope: 'review_only', verificationScope: 'release', runId: run.runId });
  expect(await savedCorrals(page)).toEqual([]);
  expect(corral.errors).toEqual([]);
});

test('[TC-UX-005-H] a saved Corral is an optional choice that can be cleared back to a normal chat', async ({
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
  await expect(page).toHaveURL(/\/edit$/);
  const saved = await savedCorrals(page);
  expect(saved).toHaveLength(1);
  const custom = saved[0];
  if (!custom) throw new Error('Creating a Corral from the template must persist it');
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  expect((await session(page)).corralId).toBeNull();

  await optionsButton(page).click();
  const dialog = optionsDialog(page);
  await dialog.getByRole('combobox', { name: 'Corral', exact: true }).click();
  await page.getByRole('option', { name: custom.name, exact: true }).click();
  await expect.poll(async () => (await session(page)).corralId).toBe(custom.corralId);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const selected = page
    .getByRole('region', { name: 'Request', exact: true })
    .getByRole('button', { name: custom.name, exact: true });
  await expect(selected).toBeVisible();
  await page.reload();
  await expect(selected).toBeVisible();
  expect((await session(page)).corralId).toBe(custom.corralId);
  await selected.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Corral', exact: true }).click();
  await page.getByRole('option', { name: 'Default chat', exact: true }).click();
  await expect.poll(async () => (await session(page)).corralId).toBeNull();
  await page.keyboard.press('Escape');
  await expect(selected).toBeHidden();
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();

  corral.fake?.answerWith('You can continue without selecting a Corral.', {
    hostReply: '{"template":"single","reason":"The saved Corral is optional"}',
  });
  await requestBox(page).fill('Continue as a normal chat.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  const run = corral.server.coordinator.listRuns()[0];
  if (!run) throw new Error('The default chat must create a run');
  expect(corral.server.coordinator.getRunSnapshot(run.runId)?.autoRoute?.template).toBe('single');
  expect(await savedCorrals(page)).toEqual(saved);
  await expect(page.getByTestId('chat-result')).toContainText(
    'You can continue without selecting a Corral.',
  );
  expect(corral.errors).toEqual([]);
});

test('[TC-UX-005-N] a queue blocked by request scope explains why outside the closed options and offers recovery', async ({
  page,
  corral,
}) => {
  await startChat(page, corral);
  corral.fake?.setResponses([
    fauxAssistantMessage('{"template":"single","reason":"Ask before continuing"}'),
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
  await optionsButton(page).click();
  const dialog = optionsDialog(page);
  const review = dialog.getByRole('switch', {
    name: 'Review only · no file changes',
    exact: true,
  });
  await review.check();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  // #89: Send says what it will do in this state, and every "new request only" item shares one
  // notice with one wording.
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute(
    'aria-description',
    'Send · Queue as next task',
  );
  const warning = page.getByRole('status').filter({
    hasText: 'Applies to a new request only: review scope',
  });
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Change scope', exact: true }).click();
  await expect(dialog).toBeVisible();
  await review.uncheck();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(requestBox(page)).toHaveValue(draft);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(async () => (await session(page)).entries.at(-1))
    .toMatchObject({ text: draft, state: 'queued', intent: 'queue' });
  expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  expect(corral.errors).toEqual([]);
});
