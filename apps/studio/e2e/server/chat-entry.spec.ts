import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.describe('ordinary chat entry', () => {
  test.use({ live: true, codexLogin: true });

  test('[TC-UX-005-H] a fresh project starts a conversation without creating a Corral', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await expect(page.getByRole('tab', { name: /^Sessions/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('step-corral')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Corral', exact: true })).toBeHidden();
    await expect(page.getByLabel('Purpose')).toBeHidden();
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);
    const sessionId = new URL(page.url()).pathname.split('/').at(-1);
    expect(corral.server.coordinator.listRuns()).toHaveLength(0);
    const session = await page.request.get(`${corral.server.url}/api/v1/sessions/${sessionId}`);
    expect((await session.json()).corralId).toBeNull();

    corral.fake?.answerWith('Here is your answer.', {
      hostReply: '{"template":"single","reason":"A direct question."}',
    });
    await requestBox(page).fill('Answer my first question.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
    await page.reload();
    await expect(page.getByTestId('chat-timeline')).toContainText('Answer my first question.');
    const persisted = await page.request.get(`${corral.server.url}/api/v1/sessions/${sessionId}`);
    expect((await persisted.json()).entries[0]).toMatchObject({
      text: 'Answer my first question.',
      state: 'started',
    });
    const corrals = await page.request.get(`${corral.server.url}/api/v1/corrals`);
    expect(await corrals.json()).toEqual([]);
    expect(corral.errors).toEqual([]);
  });
});

test('[TC-UX-005-N] an explicit optional Corral choice and draft survive project navigation', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
  await page.getByLabel('Purpose').fill('Keep the optional purpose.');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Teams/ })).toHaveAttribute('aria-selected', 'true');
  await page
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Start a session with this team', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Corral', exact: true })).toContainText(
    'Single agent',
  );
  await expect(page.getByLabel('Purpose')).toHaveValue('Keep the optional purpose.');
  await page.getByRole('tab', { name: /^Sessions/ }).click();
  await page.goto(`${corral.server.url}/projects/default#corrals`);
  await expect(page.getByRole('tab', { name: /^Teams/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  await expect(requestBox(page)).toHaveValue('Keep the optional purpose.');
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  const session = await page.request.get(`${corral.server.url}/api/v1/sessions/${sessionId}`);
  expect((await session.json()).corralId).toBeTruthy();
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  expect(corral.errors).toEqual([]);
});

test.describe('model readiness guidance', () => {
  test.use({ live: true, compatibleEndpoint: true });

  test('[TC-UX-005-H] a ready keyless compatible model completes connection guidance', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await expect(page.getByTestId('step-model')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('step-run')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('step-corral')).toHaveCount(0);
    expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  });
});

test('[TC-UX-005-N] a direct Corral library link still lets the user return to conversations', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.goto(`${corral.server.url}/projects/default#corrals`);
  await expect(page.getByRole('tab', { name: /^Teams/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /^Sessions/ }).click();
  await expect(page.getByRole('tab', { name: /^Sessions/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Sessions/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
});
