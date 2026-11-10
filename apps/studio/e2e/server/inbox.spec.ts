import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { expect, type Harness, test } from './harness.ts';

// docs/specs/features/inbox.md: answering in Needs you uses the run's own receipt, then real
// keyboard focus moves to the next item rather than to a composer.

/** Two sessions whose runs wait on an approval, and the rows and details Needs you shows them as. */
async function twoDecisions(page: Page, corral: Harness) {
  await corral.open('/');
  const definition = linearCorral(['writer'], 'inbox_team');
  const output = definition.nodes.find((node) => node.type === 'output');
  if (output?.type === 'output') output.requireApproval = true;
  const runs = await page.evaluate(async (definition) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, body: unknown) => {
      const response = await fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`setup ${path}: ${response.status}`);
      return response.json();
    };
    const saved = await call('/corrals', { definition });
    const started: string[] = [];
    for (const title of ['First decision', 'Second decision']) {
      const session = await call('/sessions', {
        projectId: 'default',
        corralId: saved.record.corralId,
        title,
      });
      const run = await call('/runs', {
        schemaVersion: '0.1',
        commandId: `start-${started.length}`,
        corralId: saved.record.corralId,
        definitionRevision: saved.record.definitionRevision,
        sessionId: session.session.sessionId,
        mode: 'mock',
      });
      started.push(run.runId);
    }
    return started;
  }, definition);
  const status = () =>
    runs.map(
      (runId) => corral.server.coordinator.listRuns().find((run) => run.runId === runId)?.status,
    );
  await expect.poll(status, { timeout: 30_000 }).toEqual(['awaiting_user', 'awaiting_user']);

  await page.goto(`${corral.server.url}/inbox`);
  const response = page.getByRole('list', { name: 'Waiting for you', exact: true });
  await expect(response.getByRole('listitem')).toHaveCount(2);
  // The rows' order is the server's; answer whichever comes first, then the one after it.
  const titles = (
    await response
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''))
  ).map((label) => label.split(' · ')[0] ?? '');
  expect([...titles].sort()).toEqual(['First decision', 'Second decision']);
  const [title = '', nextTitle = ''] = titles;
  // The group names the state; a decision's row names its run.
  const row = (name: string) =>
    page.getByRole('button', { name: `${name} · Run #1 · My project`, exact: true });
  const detail = (name: string) => page.getByRole('region', { name, exact: true });
  return { status, response, title, nextTitle, row, detail };
}

test('answers a waiting run in Needs you and moves focus to the next item after the receipt', async ({
  page,
  corral,
}) => {
  const { status, title, nextTitle, row, detail } = await twoDecisions(page, corral);
  // Until an item is chosen its place is held, quietly.
  await expect(page.getByText('Nothing selected', { exact: true })).toBeVisible();

  await row(title).focus();
  await page.keyboard.press('Enter');
  await expect(detail(title)).toBeFocused();
  await expect(page.getByText('Nothing selected', { exact: true })).toHaveCount(0);
  // The heading names the run and links to it; the list stays beside it.
  await expect(detail(title)).toContainText('Run #1 · My project');
  await expect(detail(title).getByRole('link', { name: 'Open run', exact: true })).toHaveAttribute(
    'href',
    /^\/sessions\/[^/?]+\?panel=run&view=run&run=/,
  );
  await expect(row(nextTitle)).toBeVisible();
  // Escape closes the detail and is not an answer.
  await page.keyboard.press('Escape');
  await expect(detail(title)).toHaveCount(0);
  await expect(row(title)).toBeFocused();
  expect(status()).toEqual(['awaiting_user', 'awaiting_user']);

  await page.keyboard.press('Enter');
  await detail(title).getByRole('button', { name: 'Confirm as final result', exact: true }).click();
  await expect(row(title)).toHaveCount(0);
  await expect(row(nextTitle)).toBeFocused();
  await expect(detail(title)).toContainText('This item was handled.');
  const answered = title === 'First decision' ? 0 : 1;
  await expect
    .poll(status, { timeout: 30_000 })
    .toEqual(answered === 0 ? ['succeeded', 'awaiting_user'] : ['awaiting_user', 'succeeded']);

  // The last answer leaves nothing after it: focus goes to the list's heading.
  await page.keyboard.press('Enter');
  await detail(nextTitle)
    .getByRole('button', { name: 'Confirm as final result', exact: true })
    .click();
  await expect(row(nextTitle)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeFocused();
  await expect(page.getByText('Nothing needs you', { exact: true })).toBeVisible();
  expect(corral.errors).toEqual([]);
});

test('a narrow window shows the chosen item in the list’s place and leads back to it', async ({
  page,
  corral,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { status, response, title, nextTitle, row, detail } = await twoDecisions(page, corral);
  const sideways = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  await expect(page.getByText('Nothing selected', { exact: true })).toBeHidden();
  expect(await sideways()).toBe(0);

  await row(title).click();
  await expect(detail(title)).toBeFocused();
  await expect(response).toBeHidden();
  await expect(detail(title).getByRole('button', { name: 'Close', exact: true })).toBeHidden();
  expect(await sideways()).toBe(0);
  // The way back is not an answer.
  await detail(title).getByRole('button', { name: 'Back to list', exact: true }).click();
  await expect(detail(title)).toHaveCount(0);
  await expect(row(title)).toBeFocused();
  expect(status()).toEqual(['awaiting_user', 'awaiting_user']);

  // After the receipt the list is back, with the notice above it and focus on the next item.
  await row(title).click();
  await detail(title).getByRole('button', { name: 'Confirm as final result', exact: true }).click();
  await expect(detail(title)).toContainText('This item was handled.');
  await expect(row(title)).toHaveCount(0);
  await expect(row(nextTitle)).toBeFocused();
  await detail(title).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(detail(title)).toHaveCount(0);
  expect(corral.errors).toEqual([]);
});
