import { requestBox, slash } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true });

test('an idle second tab discovers a remote request and answer without replacing its draft', async ({
  page,
  context,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const originalPath = new URL(page.url()).pathname;
  const second = await context.newPage();
  try {
    await second.goto(page.url());
    await requestBox(second).fill('Keep this unsent draft');
    corral.fake?.answerWith('The remote request finished.');
    await requestBox(page).fill('Send from the first tab.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(second.getByTestId('chat-timeline')).toContainText('Send from the first tab.');
    await expect(second.getByTestId('chat-timeline')).toContainText('The remote request finished.');
    await expect(requestBox(second)).toHaveValue('Keep this unsent draft');
    await page.goto(`${corral.server.url}/`);
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);
    const otherPath = new URL(page.url()).pathname;
    expect(otherPath).not.toBe(originalPath);
    const firstSidebarSession = page
      .getByTestId('app-sidebar')
      .locator('a[href^="/sessions/"]')
      .first();
    await expect(firstSidebarSession).toHaveAttribute('href', `${otherPath}?compose=true`);
    corral.fake?.answerWith('The background request finished.');
    await second.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(second.getByTestId('chat-timeline')).toContainText(
      'The background request finished.',
    );
    await expect(firstSidebarSession).toHaveAttribute('href', `${originalPath}?compose=true`);
    await expect(page).toHaveURL(new RegExp(otherPath));
    expect(corral.errors).toEqual([]);
  } finally {
    await second.close();
  }
});

test.describe('shared automatic queue', () => {
  let release = () => {};
  let reply = Promise.resolve();
  test.use({
    live: false,
    codexLogin: false,
    agentReply: { reply: () => 'Queued response', beforeReply: () => reply },
  });
  test('two tabs start the same saved item once and preserve both drafts', async ({
    page,
    context,
    corral,
  }) => {
    reply = new Promise<void>((resolve) => {
      release = resolve;
    });
    let unblock = () => {};
    const bothSubmitted = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const commands: string[] = [];
    const second = await context.newPage();
    try {
      await corral.open('/');
      await page.getByRole('button', { name: 'Start chat', exact: true }).click();
      await requestBox(page).fill('Initial request');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('running');
      await slash(page, 'queue');
      await requestBox(page).fill('Run this queued item once');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await second.goto(page.url());
      for (const tab of [page, second]) {
        await expect(tab.getByRole('button', { name: 'Start now', exact: true })).toBeVisible();
        const auto = tab.getByRole('switch', {
          name: 'Start the next queued task when the run ends',
          exact: true,
        });
        if ((await auto.getAttribute('aria-checked')) !== 'true') await auto.click();
        await tab.route('**/api/v1/runs/auto', async (route) => {
          const body = route.request().postDataJSON();
          if (body.brief === 'Run this queued item once') {
            commands.push(body.commandId);
            if (commands.length === 2) unblock();
            await bothSubmitted;
          }
          await route.continue();
        });
      }
      await requestBox(page).fill('Keep the first draft');
      await requestBox(second).fill('Keep the second draft');
      release();
      await expect.poll(() => commands.length).toBe(2);
      expect(new Set(commands).size).toBe(1);
      await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(2);
      for (const tab of [page, second]) {
        await expect(tab.getByRole('button', { name: 'Start now', exact: true })).toHaveCount(0);
        await expect(tab.getByTestId('chat-timeline')).toContainText('Run this queued item once');
      }
      await expect(requestBox(page)).toHaveValue('Keep the first draft');
      await expect(requestBox(second)).toHaveValue('Keep the second draft');
      expect(corral.server.coordinator.listRuns()).toHaveLength(2);
      expect(corral.errors).toEqual([]);
    } finally {
      release();
      unblock();
      await second.close();
    }
  });
});
