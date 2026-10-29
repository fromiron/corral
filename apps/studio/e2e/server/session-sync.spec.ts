import { requestBox } from '../workbench.ts';
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
    await expect(firstSidebarSession).toHaveAttribute('href', otherPath);
    corral.fake?.answerWith('The background request finished.');
    await second.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(second.getByTestId('chat-timeline')).toContainText(
      'The background request finished.',
    );
    await expect(firstSidebarSession).toHaveAttribute('href', originalPath);
    await expect(page).toHaveURL(new RegExp(otherPath));
    expect(corral.errors).toEqual([]);
  } finally {
    await second.close();
  }
});
