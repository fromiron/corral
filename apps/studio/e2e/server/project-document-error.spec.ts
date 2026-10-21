import { closeRequestOptions, openRequestOptions, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test('[TC-UX-005-N] an attachment failure stays visible after request options close and can be retried', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('tab', { name: 'Project folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document name', exact: true }).fill('Review guide');
  await page
    .getByRole('textbox', { name: 'Contents', exact: true })
    .fill('Preserve the documented public API.');
  await page.getByRole('button', { name: 'Add document', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review guide · v1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const draft = 'Review the implementation using the selected project guide.';
  await requestBox(page).fill(draft);

  let failAttachment!: () => void;
  let attachmentRequested!: () => void;
  const pendingFailure = new Promise<void>((resolve) => {
    failAttachment = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    attachmentRequested = resolve;
  });
  const attachmentUrl = '**/api/v1/projects/*/materials/attachment';
  const failure = 'The project document changed. Select its current version and try again.';
  await page.route(attachmentUrl, async (route) => {
    attachmentRequested();
    await pendingFailure;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: failure } }),
    });
  });

  await openRequestOptions(page);
  await page.getByRole('combobox', { name: 'Attach project document to this request' }).click();
  await page.getByRole('option', { name: 'Review guide · v1', exact: true }).click();
  await requested;
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await closeRequestOptions(page);
  failAttachment();
  await expect(page.getByRole('alert').filter({ hasText: failure })).toBeVisible();
  await expect(requestBox(page)).toHaveValue(draft);
  await expect(
    page.getByRole('button', { name: 'Remove Review guide (v1).md', exact: true }),
  ).toBeHidden();
  expect(corral.server.coordinator.listRuns()).toEqual([]);

  await page.unroute(attachmentUrl);
  await openRequestOptions(page);
  await page.getByRole('combobox', { name: 'Attach project document to this request' }).click();
  await page.getByRole('option', { name: 'Review guide · v1', exact: true }).click();
  await closeRequestOptions(page);
  await expect(
    page.getByRole('button', { name: 'Remove Review guide (v1).md', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: failure })).toBeHidden();
  await expect(requestBox(page)).toHaveValue(draft);
  await page.reload();
  await expect(requestBox(page)).toHaveValue(draft);
  await expect(
    page.getByRole('button', { name: 'Remove Review guide (v1).md', exact: true }),
  ).toBeVisible();
});
