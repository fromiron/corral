import { newConversation } from '../workbench.ts';
import { expect, test } from './harness.ts';

test('save a disabled schedule, run through Auto, and reopen its persisted history', async ({
  page,
  corral,
}) => {
  // Schedules are the sidebar's Automation screen.
  const automation = page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: 'Automation', exact: true });
  await corral.open('/');
  await newConversation(page);
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  await automation.click();
  await page.getByRole('button', { name: 'New schedule', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toContainText(
    'My project',
  );
  await page.getByLabel('Title', { exact: true }).fill('Daily project review');
  await page.getByLabel('Request', { exact: true }).fill('Summarize the available information.');
  await expect(page.getByLabel('Enable scheduled runs')).not.toBeChecked();
  await page.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(page.getByRole('button', { name: /Daily project review/ })).toBeVisible();
  // The row and the switch say it was saved disabled; no note repeats it.
  await expect(page.getByRole('cell', { name: 'Disabled', exact: true })).toBeVisible();
  await expect(page.getByLabel('Enable scheduled runs')).not.toBeChecked();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  const history = page.getByRole('region', { name: 'Run history' });
  await expect(history.getByRole('link', { name: 'Open run', exact: true })).toBeVisible();
  await expect(history.getByText('Completed', { exact: true })).toBeVisible();
  // The schedule's own row and history show the result, so no banner repeats it here.
  await expect(page.getByText('Scheduled run: Completed', { exact: true })).toHaveCount(0);
  await history.getByRole('link', { name: 'Open run', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_.*run=run_/);
  await automation.click();
  // The schedule's details name its target as project / session; the session is a link.
  await page.getByRole('button', { name: /Daily project review/ }).click();
  await page.getByRole('main').locator(`a[href="/sessions/${sessionId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`));
  await expect(page.getByTestId('chat-timeline')).toContainText('Scheduled request');
  await automation.click();
  await page.getByRole('button', { name: /Daily project review/ }).click();
  await expect(page.getByLabel('Enable scheduled runs')).not.toBeChecked();
  await expect(
    page
      .getByRole('region', { name: 'Run history' })
      .getByRole('link', { name: 'Open run', exact: true }),
  ).toHaveCount(1);
  // This step verifies persisted history with a fresh sign-in. Stop the old page's
  // authenticated polling before deliberately replacing its server session.
  await page.goto('about:blank');
  await corral.restart();
  await corral.open('/schedules');
  await page.getByRole('button', { name: /Daily project review/ }).click();
  await expect(
    page
      .getByRole('region', { name: 'Run history' })
      .getByRole('link', { name: 'Open run', exact: true }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete schedule', exact: true }).click();
  await expect(page.getByRole('button', { name: /Daily project review/ })).toHaveCount(0);
  expect(corral.errors).toEqual([]);
});
