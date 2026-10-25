import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true, reasoningApi: true, imageInput: true });

test('[TC-IMAGE-001-H] [TC-STATUS-001-H] [TC-CHAT-001-H] [TC-CHAT-001-N] attachments survive settings; the owned plan and question lead to one completed request', async ({
  page,
  corral,
}) => {
  const source = 'Private text attachment 한국어';
  const current = () => {
    const run = corral.server.coordinator.listRuns()[0];
    if (!run) throw new Error('missing fixture run');
    return { runId: run.runId, ...corral.server.coordinator.getSnapshot(run.runId) };
  };
  // CR-055: the session's conversation lead plans, asks, then replies; no auto choice is sent.
  corral.fake?.setResponses([
    (context) => {
      expect(JSON.stringify(context.messages)).toContain(source);
      expect(
        context.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === 'image' && part.mimeType === 'image/png'),
        ),
      ).toBe(true);
      return fauxAssistantMessage(
        [
          fauxToolCall('update_plan', {
            scope: 'execution',
            expectedRevision: 0,
            criteriaVersionId: current().projection.currentCriteriaVersionId,
            items: [{ id: 'answer', title: 'Read attachment and answer', status: 'in_progress' }],
          }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage(
      [
        fauxToolCall('ask_user', {
          key: 'format',
          questions: [{ id: 'format', kind: 'text', prompt: 'Which format should I use?' }],
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    (context) => {
      expect(JSON.stringify(context.messages)).toContain('A table');
      return fauxAssistantMessage(
        [
          fauxToolCall('update_plan', {
            scope: 'execution',
            expectedRevision: 1,
            criteriaVersionId: current().projection.currentCriteriaVersionId,
            items: [{ id: 'answer', title: 'Read attachment and answer', status: 'completed' }],
          }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('Attachment verified. The answer is a table.'),
  ]);
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const url = page.url();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reasoning effort', exact: true }).hover();
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toContainText('Low');
  await requestBox(page).fill('Read the attachment and use my chosen format');
  await page
    .getByLabel('Attach text files', { exact: true })
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(source) });
  await expect(page.getByRole('button', { name: 'Remove notes.txt' })).toBeVisible();
  await page.getByLabel('Attach images', { exact: true }).setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  await expect(page.getByRole('button', { name: 'Remove image pixel.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/settings=general/);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page).toHaveURL(url);
  await expect(requestBox(page)).toHaveValue('Read the attachment and use my chosen format');
  await expect(page.getByRole('button', { name: 'Remove notes.txt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove image pixel.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('action-required')).toBeVisible();
  await page.getByTestId('action-required').getByRole('link').click();
  const question = page.getByRole('form', { name: 'Waiting for your answer' });
  await expect(question).toHaveCount(1);
  await expect(
    page.getByTestId('composer-work-plan').getByText('Read attachment and answer', { exact: true }),
  ).toBeVisible();
  const answer = question.getByRole('textbox', { name: 'Your answer' });
  await answer.fill('A table');
  expect(
    await answer.evaluate(
      (element) =>
        !element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    ),
  ).toBe(true);
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByTestId('chat-result')).toContainText('Attachment verified');
  await expect.poll(() => current().projection.status).toBe('succeeded');
  expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  const calls = current().projection.budget.modelCalls;
  await page.reload();
  await expect(page.getByTestId('chat-result')).toContainText('Attachment verified');
  await page.getByRole('list', { name: 'Attached text files' }).locator('summary').click();
  await expect(page.getByRole('list', { name: 'Attached text files' })).toContainText(source);
  await page.getByRole('list', { name: 'Attached images' }).locator('summary').click();
  await expect(page.getByRole('img', { name: 'pixel.png' })).toBeVisible();
  expect(
    await page
      .getByRole('img', { name: 'pixel.png' })
      .evaluate((element: HTMLImageElement) => element.naturalWidth),
  ).toBe(1);
  expect(current().projection.budget.modelCalls).toBe(calls);
  await page.getByRole('button', { name: 'View run', exact: true }).click();
  await page.getByTestId('compact-run').getByText('Executions', { exact: true }).click();
  for (const card of ['environment', 'context', 'connections', 'changes'])
    await expect(page.getByTestId(`status-${card}`)).toBeVisible();
  await page.getByTestId('status-context').locator(':scope > summary').click();
  await expect(page.getByTestId('status-context')).toContainText(/About [0-9,]+ message tokens/);
  await expect(page.getByTestId('status-context')).toContainText('Model context limit:');
  expect(corral.errors).toEqual([]);
});
