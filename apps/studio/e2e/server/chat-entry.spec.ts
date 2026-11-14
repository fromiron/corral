import { newConversation, openConversationDetails, openLibrary, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.describe('ordinary chat entry', () => {
  test.use({ live: true, codexLogin: true });

  test('a fresh project starts a conversation without creating a Corral', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await expect(page.getByRole('tab', { name: /^Conversations/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('step-corral')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Corral', exact: true })).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Purpose', exact: true })).toBeHidden();
    await newConversation(page);
    await expect(page).toHaveURL(/\/sessions\/session_/);
    const sessionId = new URL(page.url()).pathname.split('/').at(-1);
    expect(corral.server.coordinator.listRuns()).toHaveLength(0);
    const session = await page.request.get(`${corral.server.url}/api/v1/sessions/${sessionId}`);
    expect((await session.json()).corralId).toBeNull();

    corral.fake?.answerWith('Here is your answer.');
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

test('an explicit optional Corral choice and draft survive project navigation', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const details = await openConversationDetails(page);
  await details
    .getByRole('textbox', { name: 'Purpose', exact: true })
    .fill('Keep the optional purpose.');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  // Templates are in the library; the view survives a reload.
  await openLibrary(page, 'Templates');
  await page.reload();
  await expect(
    page
      .getByRole('tablist', { name: 'Library views' })
      .getByRole('tab', { name: 'Templates', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page
    .getByRole('button', { name: 'New conversation with Single agent', exact: true })
    .click();
  // The project's new conversation opens with the team chosen and the saved purpose, unstarted.
  await expect(details.getByRole('combobox', { name: 'Corral', exact: true })).toContainText(
    'Single agent',
  );
  await expect(details.getByRole('textbox', { name: 'Purpose', exact: true })).toHaveValue(
    'Keep the optional purpose.',
  );
  await page.keyboard.press('Escape');
  // The project's old link to its teams opens the library's teams of that project.
  await page.goto(`${corral.server.url}/projects/default#corrals`);
  await expect(page).toHaveURL(/\/library\/teams\?project=default$/);
  await expect(
    page.getByRole('tablist', { name: 'Library views' }).getByRole('tab', { name: 'Corrals' }),
  ).toHaveAttribute('aria-selected', 'true');
  await page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: 'My project', exact: true })
    .click();
  // Saved details are shown before the conversation starts with them.
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(details.getByRole('combobox', { name: 'Corral', exact: true })).toContainText(
    'Single agent',
  );
  await details.getByRole('button', { name: 'Start chat', exact: true }).click();
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

  // workbench.md (기본 입구): the empty Sessions tab is one empty state, with a model link only
  // when no model can be used; there are no step-by-step start cards.
  test('a ready keyless compatible model needs no connection step', async ({ page, corral }) => {
    await corral.open('/');
    await expect(page.getByText('No conversations yet', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'Connect a model' })).toHaveCount(
      0,
    );
    await expect(page.getByTestId('sidebar-status')).toHaveCount(0);
    for (const step of ['step-model', 'step-run', 'step-corral'])
      await expect(page.getByTestId(step)).toHaveCount(0);
    expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  });
});

test('a direct Corral library link still lets the user return to conversations', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.goto(`${corral.server.url}/projects/default#corrals`);
  // library.md: the old link replaces itself with the library's teams of that project.
  await expect(page).toHaveURL(/\/library\/teams\?project=default$/);
  await expect(
    page.getByRole('tablist', { name: 'Library views' }).getByRole('tab', { name: 'Corrals' }),
  ).toHaveAttribute('aria-selected', 'true');
  // Back returns to the work screen before it.
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/default$/);
  await expect(page.getByRole('tab', { name: /^Conversations/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Conversations/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
});
