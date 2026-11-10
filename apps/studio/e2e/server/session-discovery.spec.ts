import {
  newConversation,
  openConversationDetails,
  openSessionSearch,
  requestBox,
} from '../workbench.ts';
import { expect, test } from './harness.ts';

test('archived sessions run only after explicit sending and stay archived', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await newConversation(page);
  await expect(requestBox(page)).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  const sidebarSession = page
    .getByTestId('app-sidebar')
    .locator(`a[href="/sessions/${sessionId}?compose=true"]`);
  await expect(sidebarSession).toBeVisible();
  await page
    .getByRole('banner')
    .getByRole('button', { name: /Actions for/ })
    .click();
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Sending a message keeps this session archived.')).toBeVisible();
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  await requestBox(page).fill('A new request in this archived session');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(1);
  const response = await page.request.get(`${corral.server.url}/api/v1/sessions/${sessionId}`);
  expect((await response.json()).archivedAt).toBeTruthy();
  await expect(sidebarSession).toHaveCount(0);
  await expect(page.getByText('Sending a message keeps this session archived.')).toBeVisible();
});

test('search scopes lead to explicit private search and group matching entries by session', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const details = await openConversationDetails(page);
  await details.getByRole('textbox', { name: 'Session name' }).fill('Search fixture');
  await details.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(requestBox(page)).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  await page.evaluate(async (id) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    for (const text of ['Find the moonstone request', 'A second moonstone request']) {
      const response = await fetch(`/api/v1/sessions/${id}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({ intent: 'next', text, state: 'refused' }),
      });
      if (!response.ok) throw new Error(`Fixture entry failed: ${response.status}`);
    }
  }, sessionId);
  await page.reload();
  // The sidebar's search field opens the palette on sessions: it finds titles and purposes in the
  // scope it shows, and message and result text is a separate search at the end of its list.
  const { palette, input } = await openSessionSearch(page);
  await input.fill('moonstone');
  const scope = palette.getByRole('group', { name: 'Find sessions in', exact: true });
  await expect(scope.getByRole('button', { name: 'My project', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await scope.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(scope.getByRole('button', { name: 'All projects', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await palette
    .getByRole('option', { name: 'Search messages and results for “moonstone”', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Search sessions and results' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^All projects · titles and purposes\./)).toBeVisible();
  await expect(
    dialog.getByRole('switch', { name: 'Include private messages and results' }),
  ).toHaveAttribute('aria-checked', 'false');
  await expect(
    dialog.getByText(
      'No title or purpose matches. Enable private messages and results to search their text.',
    ),
  ).toBeVisible();
  await dialog.getByRole('switch', { name: 'Include private messages and results' }).click();
  await expect(dialog.locator('mark')).toHaveCount(2);
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveCount(1);
  await expect(dialog.getByRole('link')).toHaveCount(2);
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  expect(corral.errors).toEqual([]);
});

test('primary icon controls expose tooltips on hover and keyboard focus', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await newConversation(page);
  await expect(requestBox(page)).toBeVisible();
  const sidebar = page.getByTestId('app-sidebar');
  // Session search is the sidebar's labelled search field now, not an icon control.
  const controls = [
    [sidebar.getByRole('link', { name: 'New conversation', exact: true }), 'New conversation'],
    [sidebar.getByRole('button', { name: 'Hide the sidebar' }), 'Hide the sidebar'],
    [
      page.getByRole('banner').getByRole('button', { name: /Actions for/ }),
      'Actions for New session',
    ],
    [page.getByRole('button', { name: 'Open file viewer', exact: true }), 'Open file viewer'],
    [page.getByRole('banner').getByRole('button', { name: 'Search', exact: true }), 'Search'],
    [page.getByRole('button', { name: 'Attachments', exact: true }), 'Attachments'],
  ] as const;
  for (const [control, name] of controls) {
    await control.hover();
    await expect(page.getByRole('tooltip', { name: new RegExp(name) })).toBeVisible();
    await page.mouse.move(700, 700);
    await page.keyboard.press('Tab');
    await control.focus();
    await expect(page.getByRole('tooltip', { name: new RegExp(name) })).toBeVisible();
    await expect(control).toHaveAttribute('aria-describedby', /.+/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip', { name: new RegExp(name) })).toBeHidden();
  }
  await page.screenshot({ path: test.info().outputPath('session-controls.png') });
  expect(corral.errors).toEqual([]);
});
