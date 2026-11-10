import { openConversationDetails, openProject, openTextSearch, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test('sidebar reentry opens the conversation and search highlights its exact message over a remembered panel', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const details = await openConversationDetails(page);
  await details.getByRole('textbox', { name: 'Session name' }).fill('Reentry fixture');
  await details.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(requestBox(page)).toBeVisible();
  await expect(page).toHaveTitle('Reentry fixture · Corral Studio');
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  const entryId = await page.evaluate(async (id) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const response = await fetch(`/api/v1/sessions/${id}/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        intent: 'next',
        text: 'Find the MoonStone request',
        state: 'refused',
      }),
    });
    if (!response.ok) throw new Error(`Fixture entry failed: ${response.status}`);
    const saved = await (await fetch(`/api/v1/sessions/${id}`)).json();
    return saved.entries[0].entryId as string;
  }, sessionId);
  await page.reload();
  await page.getByRole('button', { name: 'Set up file work', exact: true }).click();
  await expect(page).toHaveURL(/panel=changes/);
  await openProject(page);
  await page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: /Reentry fixture/ })
    .click();
  await expect(requestBox(page)).toBeVisible();
  await expect(page).toHaveURL(/compose=true/);
  await page.getByRole('button', { name: 'Set up file work', exact: true }).click();
  const dialog = await openTextSearch(page);
  await dialog.getByRole('textbox').fill('moonstone');
  await dialog.getByRole('switch', { name: 'Include private messages and results' }).click();
  await expect(dialog.locator('mark')).toHaveText('MoonStone');
  await dialog.getByRole('link').click();
  await expect(dialog).toBeHidden();
  await expect(requestBox(page)).toBeVisible();
  const selected = page.locator(`[data-chat-item="${entryId}"]`);
  await expect(selected).toHaveAttribute('aria-current', 'location');
  await expect(selected).toBeInViewport();
  expect(corral.server.coordinator.listRuns()).toEqual([]);
  expect(corral.errors).toEqual([]);
});

test('renaming the active session updates the document title and the path keeps its name in view', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const activeId = await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    let last = '';
    for (let index = 0; index < 18; index++) {
      const response = await fetch('/api/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({ projectId: 'default', title: `Overflow session ${index}` }),
      });
      if (!response.ok) throw new Error(`Fixture session failed: ${response.status}`);
      last = (await response.json()).session.sessionId;
    }
    return last;
  });
  await corral.open(`/sessions/${activeId}`);
  // The top bar's path names the open session; its name stays until the last (workbench.md
  // 전역 셸과 화면 틀: "경로의 현재 세션(또는 화면) 이름과 검색은 마지막까지 남는다").
  const current = page
    .getByRole('navigation', { name: 'Current location', exact: true })
    .getByRole('heading', { level: 2 });
  await expect(current).toHaveText('Overflow session 17');
  await page
    .getByRole('banner')
    .getByRole('button', { name: /Actions for/ })
    .click();
  await page.getByRole('menuitem', { name: 'Rename session', exact: true }).click();
  const rename = page.getByTestId('rename-session-dialog');
  await rename.getByRole('textbox', { name: 'Session title' }).fill('Renamed active session');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rename).toBeHidden();
  await expect(page).toHaveTitle('Renamed active session · Corral Studio');
  await expect(current).toHaveText('Renamed active session');
  await expect(current).toBeInViewport();
  await page.setViewportSize({ width: 780, height: 800 });
  await expect(current).toBeInViewport();
  expect(corral.errors).toEqual([]);
});

// The session tab strip was removed before the redesign (18bc4e25), while workbench.md
// (범위와 연속성) still says the active session tab stays in view. Kept as the behavior to decide on.
test.fixme('the active session tab stays in view when the tab strip overflows', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const activeId = await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const tabs: { sessionId: string; href: string }[] = [];
    for (let index = 0; index < 18; index++) {
      const response = await fetch('/api/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({ projectId: 'default', title: `Overflow session ${index}` }),
      });
      if (!response.ok) throw new Error(`Fixture session failed: ${response.status}`);
      const { session } = await response.json();
      tabs.push({ sessionId: session.sessionId, href: `/sessions/${session.sessionId}` });
    }
    localStorage.setItem('corral:session-tabs:v1', JSON.stringify(tabs));
    return tabs.at(-1)?.sessionId;
  });
  await corral.open(`/sessions/${activeId}`);
  const tabs = page.getByRole('navigation', { name: 'Session tabs', exact: true });
  const activeTab = tabs.locator('a[aria-current="page"]');
  await expect(activeTab).toBeInViewport();
  await tabs.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await page
    .getByRole('banner')
    .getByRole('button', { name: /Actions for/ })
    .click();
  await page.getByRole('menuitem', { name: 'Rename session', exact: true }).click();
  const rename = page.getByTestId('rename-session-dialog');
  await rename.getByRole('textbox', { name: 'Session title' }).fill('Renamed active session');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(activeTab).toHaveText('Renamed active session');
  await expect(activeTab).toBeInViewport();
  await page.setViewportSize({ width: 780, height: 800 });
  await expect(activeTab).toBeInViewport();
});
