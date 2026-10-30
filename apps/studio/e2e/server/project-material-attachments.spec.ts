import type { WorkSession } from '@corral/core';
import type { Page } from '@playwright/test';
import { requestBox } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

test.use({ live: true, codexLogin: true, reasoningApi: true });

async function prepare(page: Page, corral: Harness) {
  await corral.open('/');
  await page.getByRole('tab', { name: 'Instructions & memory' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Coding style');
  await page.getByRole('textbox', { name: 'Contents', exact: true }).fill('Use strict TypeScript.');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Coding style · v1', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^Sessions/ }).click();
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(requestBox(page)).toBeVisible();
  await requestBox(page).fill('Review my code');
}

async function attach(page: Page) {
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Attach instructions or memory', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Attach instructions or memory', exact: true });
  await dialog
    .getByRole('combobox', { name: 'Attach project instructions or memory to this request' })
    .click();
  await page.screenshot({ path: test.info().outputPath('material-selection.png') });
  await page.getByRole('option', { name: 'Coding style · v1', exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
  return dialog;
}

async function session(page: Page): Promise<WorkSession> {
  const id = new URL(page.url()).pathname.split('/').at(-1);
  const response = await page.request.get(new URL(`/api/v1/sessions/${id}`, page.url()).href);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('explicit material selection survives reload and pins the submitted version after editing the source', async ({
  page,
  corral,
}) => {
  await prepare(page, corral);
  expect((await session(page)).entries).toEqual([]);
  const dialog = await attach(page);
  await expect(dialog).toBeHidden();
  const saved = await page.evaluate(
    () =>
      Object.entries(localStorage).find(
        ([key]) => key.includes('session-draft') && key.includes('session_'),
      )?.[1],
  );
  expect(saved).toContain('Use strict TypeScript.');
  await page.reload();
  await expect(requestBox(page)).toHaveValue('Review my code');
  // Editing the project record after selection must not silently replace the draft snapshot.
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await page.getByRole('tab', { name: 'Instructions & memory' }).click();
  await page.getByRole('button', { name: 'Coding style · v1', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Contents', exact: true })
    .fill('Use a different convention.');
  await page.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Coding style · v2', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Session tabs', exact: true })
    .getByRole('link')
    .click();
  corral.fake?.answerWith('The selected instructions were reviewed.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await session(page)).entries[0]?.state).toBe('started');
  expect((await session(page)).entries[0]?.attachments?.[0]?.text).toBe('Use strict TypeScript.');
  await expect(page.getByTestId('chat-timeline')).toContainText('Coding style (v1).md');
  await page.reload();
  expect((await session(page)).entries[0]?.attachments?.[0]?.text).toBe('Use strict TypeScript.');
  await expect(page.getByTestId('chat-timeline')).toContainText('Coding style (v1).md');
  expect(corral.errors).toEqual([]);
});

test('closing a pending material selection preserves the draft and ignores its late response', async ({
  page,
  corral,
}) => {
  await prepare(page, corral);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/materials/attachment', async (route) => {
    requested = true;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  const dialog = await attach(page);
  await expect.poll(() => requested).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Send', exact: true, includeHidden: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  release();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(requestBox(page)).toHaveValue('Review my code');
  corral.fake?.answerWith('The request has no project material.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await session(page)).entries[0]?.state).toBe('started');
  expect((await session(page)).entries[0]?.attachments ?? []).toEqual([]);
  expect(corral.errors).toEqual([]);
});

test('a failed material selection is visible and leaves the existing draft intact', async ({
  page,
  corral,
}) => {
  await prepare(page, corral);
  await page.route('**/materials/attachment', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { message: 'The selected version changed. Select it again.' },
      }),
    }),
  );
  const dialog = await attach(page);
  await expect(dialog.getByRole('alert')).toContainText('The selected version changed');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(requestBox(page)).toHaveValue('Review my code');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  expect((await session(page)).entries).toEqual([]);
  expect(corral.server.coordinator.listRuns()).toEqual([]);
  expect(corral.errors).toEqual([
    'Failed to load resource: the server responded with a status of 409 (Conflict)',
  ]);
});
