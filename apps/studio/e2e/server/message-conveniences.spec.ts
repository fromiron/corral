import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true });

test('renders safe code, copies exact text, and edits a collapsed request as a new draft', async ({
  page,
  context,
  corral,
}) => {
  await corral.open('/');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  const source = 'const message: string = "<script>safe</script>";\n';
  corral.fake?.answerWith(
    `**Readable answer**\n\n\`\`\`ts\n${source}\`\`\`\n\n[unsafe](javascript:alert(1))`,
  );
  const request = `${'A long request. '.repeat(650)}END-OF-REQUEST`;
  await requestBox(page).fill(request);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const timeline = page.getByTestId('chat-timeline');
  const result = page.getByTestId('chat-result');
  await expect(result.locator('strong')).toHaveText('Readable answer');
  await expect(result.locator('pre code')).toHaveText(source);
  await expect(result.locator('pre code span').first()).toBeVisible();
  await expect(result.locator('[data-code-language]')).toHaveText('ts');
  await expect(result.locator('script, a[href^="javascript:"]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('message-actions.png') });
  await result.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await expect(timeline).not.toContainText('END-OF-REQUEST');
  await timeline.getByRole('button', { name: 'Copy message', exact: true }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(request);
  await timeline.getByRole('button', { name: 'Show full message', exact: true }).click();
  await expect(timeline).toContainText('END-OF-REQUEST');
  const runs = corral.server.coordinator.listRuns();
  await timeline.getByRole('button', { name: 'Edit as new request', exact: true }).click();
  await expect(requestBox(page)).toHaveValue(request);
  expect(corral.server.coordinator.listRuns()).toEqual(runs);
  await page.reload();
  await expect(page.getByTestId('chat-result').locator('pre code')).toHaveText(source);
  expect(corral.errors).toEqual([]);
});

test.describe('incomplete response', () => {
  test.use({ streamTokensPerSecond: 40 });
  test('keeps rendered partial text after cancel, reload and server restart', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    corral.fake?.answerWith(
      `**Saved partial reply**\n\n${'Still writing a long response. '.repeat(1000)}`,
    );
    await requestBox(page).fill('Write a long response so I can stop it.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const partial = page.getByTestId('live-text');
    await expect(partial.locator('strong')).toHaveText('Saved partial reply');
    await page
      .getByTestId('chat-composer')
      .getByRole('button', { name: 'Cancel whole run', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    if (await dialog.isVisible())
      await dialog
        .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
        .click();
    await expect(partial).toContainText('Incomplete response');
    const runId = corral.server.coordinator.listRuns()[0]?.runId;
    if (!runId) throw new Error('Missing conversation run');
    await expect
      .poll(() => corral.server.coordinator.getSnapshot(runId).projection.status)
      .toBe('cancelled');
    expect(corral.server.coordinator.getSnapshot(runId).projection.output).toBeNull();
    await page.reload();
    await expect(page.getByTestId('live-text').locator('strong')).toHaveText('Saved partial reply');
    const path = new URL(page.url()).pathname;
    await corral.restart();
    await corral.open(path);
    await expect(page.getByTestId('live-text')).toContainText('Incomplete response');
    await expect(page.getByTestId('live-text').locator('strong')).toHaveText('Saved partial reply');
    await expect(page.getByTestId('chat-result')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('interrupted-reply.png') });
  });
});
