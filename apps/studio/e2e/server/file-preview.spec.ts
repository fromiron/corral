import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import { closeRequestOptions, openRequestOptions, panelTab, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test('[TC-ABS-004-H] [TC-ABS-004-N] session file preview isolates cookies, reads refreshed assets and closes its lease', async ({
  page,
  corral,
}, testInfo) => {
  test.setTimeout(60_000);
  const original = mkdtempSync(join(tmpdir(), 'corral-preview-e2e-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('init', '-q');
  writeFileSync(
    join(original, 'index.html'),
    '<h1>Preview from the working copy</h1><button onclick="this.textContent=\'Executed\'">Static button</button><script>document.body.dataset.executed="yes"</script>',
  );
  git('add', '.');
  git('commit', '-q', '-m', 'preview source');
  let previewUrl = '';
  let leaseId = '';
  let resolvePreview!: () => void;
  const previewStarted = new Promise<void>((resolve) => {
    resolvePreview = resolve;
  });
  const previewCookies: string[] = [];
  // The harness's external-network guard continues to reject all other destinations.
  await page.route('http://127.0.0.2:*/**', async (route) => {
    await previewStarted;
    const target = new URL(route.request().url());
    const owned = previewUrl && new URL(previewUrl);
    if (
      !owned ||
      target.origin !== owned.origin ||
      target.pathname.split('/')[1] !== owned.pathname.split('/')[1]
    )
      return route.abort();
    previewCookies.push((await route.request().allHeaders()).cookie ?? '');
    return route.continue();
  });
  page.on('response', async (response) => {
    if (
      response.request().method() === 'POST' &&
      /\/previews$/.test(response.url()) &&
      response.ok()
    ) {
      const body = await response.json();
      previewUrl = body.url;
      leaseId = body.leaseId;
      resolvePreview();
    }
  });
  try {
    await corral.open('/');
    await page.getByRole('tab', { name: /^Project folder/ }).click();
    const folder = page.getByRole('tabpanel', { name: 'Project folder' });
    await folder.getByLabel('Folder path on this computer').fill(original);
    await folder.getByRole('button', { name: 'Link folder' }).click();
    const trust = folder.getByRole('switch', { name: /Trust this repository/ });
    await expect(trust).toBeVisible();
    await trust.click();
    await expect(trust).toBeChecked();
    await page.getByRole('tab', { name: /^Sessions/ }).click();
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);
    const sessionId = new URL(page.url()).pathname.split('/')[2];
    if (!sessionId) throw new Error('session did not open');
    await panelTab(page, 'Files');
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    await page
      .getByRole('region', { name: 'Working copy' })
      .getByRole('button', { name: /Make a working copy from/ })
      .click();
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'Open index.html', exact: true }).click();
    await page.getByRole('button', { name: 'Open preview', exact: true }).click();
    const frame = page.frameLocator('[data-testid="file-preview-frame"]');
    await expect(
      frame.getByRole('heading', { name: 'Preview from the working copy' }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('file-preview.png') });
    expect(previewCookies.length).toBeGreaterThan(0);
    expect(previewCookies.every((cookie) => cookie === '')).toBe(true);
    await frame.getByRole('button', { name: 'Static button' }).click();
    await expect(frame.getByRole('button', { name: 'Static button' })).toBeVisible();
    const copies = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: original })
      .toString('utf8')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
    const copy = copies.find((path) => path.endsWith(`/${sessionId}`));
    if (!copy) throw new Error('working copy was not created');
    // Editing the approved copy externally must be reflected by the ordinary refresh control.
    writeFileSync(join(copy, 'index.html'), '<h1>Updated preview</h1>');
    await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
    await expect(frame.getByRole('heading', { name: 'Updated preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(page.getByTestId('file-preview-frame')).toHaveCount(0);
    const readback = await page.request.get(
      `${corral.server.url}/api/v1/sessions/${sessionId}/previews`,
    );
    expect(await readback.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ leaseId, state: 'stopped' })]),
    );
  } finally {
    // Harness closes the worktree before its own cleanup; the original has no preview listener.
    await rm(original, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test.describe('run-owned previews', () => {
  test.use({ live: true, codexLogin: true });
  test('[TC-ABS-004-H] the normal request flow exposes the model lease in Files and closes it when the run completes', async ({
    page,
    corral,
  }, testInfo) => {
    test.skip(
      !process.env.CORRAL_BROWSER_EXECUTABLE,
      'Requires an explicitly selected installed Chromium executable.',
    );
    test.setTimeout(90_000);
    const original = mkdtempSync(join(tmpdir(), 'corral-model-preview-e2e-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
        cwd: original,
      });
    git('init', '-q');
    writeFileSync(
      join(original, 'index.html'),
      "<h1>Run-owned preview</h1><button onclick=\"document.querySelector('p').textContent='Count: 1'\">Add</button><p>Count: 0</p>",
    );
    git('add', '.');
    git('commit', '-q', '-m', 'preview application');
    let leaseId = '';
    let previewUrl = '';
    const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
    corral.fake?.setResponses([
      fauxAssistantMessage('{"template":"single","reason":"Inspect the local application"}'),
      tool('preview_file', { path: 'index.html' }),
      (context) => {
        leaseId = /preview_[a-f0-9]{32}/.exec(JSON.stringify(context.messages))?.[0] ?? '';
        expect(leaseId).not.toBe('');
        return tool('preview_action', { leaseId, tool: 'browser_snapshot', args: {} });
      },
      (context) => {
        const latest = context.messages.at(-1);
        if (latest?.role !== 'toolResult')
          throw new Error('Browser snapshot did not reach the model');
        const snapshot = latest.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        const ref = /button[^\r\n]*?Add[^\r\n]*?\[ref=([^\]]+)\]/.exec(snapshot)?.[1];
        if (!ref) throw new Error('Model did not receive a live browser reference');
        return tool('preview_action', {
          leaseId,
          tool: 'browser_click',
          args: { element: 'Add', target: ref },
        });
      },
      () =>
        tool('preview_action', {
          leaseId,
          tool: 'browser_verify_text_visible',
          args: { text: 'Count: 1' },
        }),
      (context) => {
        const verification = context.messages.at(-1);
        if (verification?.role !== 'toolResult')
          throw new Error('Browser assertion result did not reach the model');
        expect(verification.isError).not.toBe(true);
        const text = verification.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        expect(text).not.toMatch(/"(?:isError)"\s*:\s*true|"ok"\s*:\s*false/);
        return tool('ask_user', {
          key: 'preview',
          questions: [{ id: 'preview', kind: 'text', prompt: 'Keep this preview?' }],
        });
      },
      tool('write_artifact', { text: 'The live browser interaction was verified.' }),
      (context) => {
        const latest = context.messages.at(-1);
        if (latest?.role !== 'toolResult')
          throw new Error('Written artifact did not reach the model');
        const text = latest.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        const written = JSON.parse(text).artifactVersionId;
        if (typeof written !== 'string') throw new Error('Written artifact version is missing');
        return tool('submit_result', { artifactVersionIds: [written] });
      },
      fauxAssistantMessage('Done.'),
    ]);
    await page.route('http://127.0.0.2:*/**', (route) => {
      if (!previewUrl || new URL(route.request().url()).origin !== new URL(previewUrl).origin)
        return route.abort();
      return route.continue();
    });
    try {
      await corral.open('/settings/harness?projectId=default');
      await page.getByLabel('Work style name', { exact: true }).fill('Preview work style');
      await page.getByRole('combobox', { name: 'Policy', exact: true }).click();
      await page.getByRole('option', { name: 'Trusted native extensions', exact: true }).click();
      await page.getByRole('button', { name: 'Save work style', exact: true }).click();
      await expect(page.getByTestId('harness-status')).toContainText('Saved revision 1');
      await page.goto(corral.server.url);
      await page.getByRole('tab', { name: /^Project folder/ }).click();
      const folder = page.getByRole('tabpanel', { name: 'Project folder' });
      await folder.getByLabel('Folder path on this computer').fill(original);
      await folder.getByRole('button', { name: 'Link folder' }).click();
      const trust = folder.getByRole('switch', { name: /Trust this repository/ });
      await trust.click();
      await expect(trust).toBeChecked();
      await page.getByRole('tab', { name: /^Sessions/ }).click();
      await page.getByRole('button', { name: 'Start chat', exact: true }).click();
      await expect(page).toHaveURL(/\/sessions\/session_/);
      const sessionId = new URL(page.url()).pathname.split('/')[2];
      if (!sessionId) throw new Error('Session did not open');
      await panelTab(page, 'Files');
      await page.getByRole('tab', { name: 'Changes', exact: true }).click();
      await page
        .getByRole('region', { name: 'Working copy' })
        .getByRole('button', { name: /Make a working copy from/ })
        .click();
      await openRequestOptions(page);
      await page
        .getByRole('combobox', { name: 'Work style for next request', exact: true })
        .click();
      await page.getByRole('option', { name: 'Preview work style · r1', exact: true }).click();
      await closeRequestOptions(page);
      await page
        .getByRole('combobox', { name: 'Permissions for next request', exact: true })
        .click();
      await page
        .getByRole('option')
        .filter({ has: page.getByText('Auto', { exact: true }) })
        .click();
      await requestBox(page).fill(
        'Open index.html, click Add in the preview and verify Count: 1, then ask me before completing.',
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByTestId('action-required')).toBeVisible({ timeout: 45_000 });
      await page.getByTestId('action-required').getByRole('link').click();
      await expect(page.getByRole('form', { name: 'Waiting for your answer' })).toBeVisible();
      const leasesResponse = await page.request.get(
        `${corral.server.url}/api/v1/sessions/${sessionId}/previews`,
      );
      const leases = await leasesResponse.json();
      const lease = leases.find((item: { leaseId: string }) => item.leaseId === leaseId);
      expect(lease?.runId).toBeTruthy();
      expect(lease?.state).toBe('ready');
      previewUrl = lease.url;
      await panelTab(page, 'Files');
      const previews = page.getByRole('region', { name: 'Open previews', exact: true });
      await expect(previews).toContainText('index.html');
      await previews.getByRole('button', { name: 'Open preview', exact: true }).click();
      await expect(previews.locator('iframe')).toHaveAttribute('src', previewUrl);
      await expect(
        previews.frameLocator('iframe').getByRole('heading', { name: 'Run-owned preview' }),
      ).toBeVisible();
      await expect(previews.getByRole('link', { name: 'View run', exact: true })).toHaveAttribute(
        'href',
        new RegExp(lease.runId),
      );
      await page.screenshot({ path: testInfo.outputPath('run-owned-preview.png') });
      await page.getByTestId('action-required').getByRole('link').click();
      const question = page.getByRole('form', { name: 'Waiting for your answer' });
      await question.getByRole('textbox', { name: 'Your answer' }).fill('Keep it.');
      await question.getByRole('button', { name: 'Send answer' }).click();
      // The normal quality budget requires a decision before the seventh model request.
      // Continue through that visible gate rather than changing limits behind the UI.
      await page.getByRole('button', { name: 'Continue with this version', exact: true }).click();
      await expect(page.getByTestId('chat-result')).toContainText(
        'The live browser interaction was verified.',
      );
      await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
      const ended = await page.request.get(
        `${corral.server.url}/api/v1/sessions/${sessionId}/previews`,
      );
      expect(await ended.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ leaseId, state: 'stopped' })]),
      );
    } catch (error) {
      const run = corral.server.coordinator.listRuns()[0];
      if (run) {
        const projection = corral.server.coordinator.getSnapshot(run.runId).projection;
        await testInfo.attach('preview-flow-failure', {
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify(
              {
                status: projection.status,
                executions: projection.executions,
                tools: Object.values(projection.toolCalls).map((call) => ({
                  ...call,
                  result: call.resultRef
                    ? corral.server.coordinator.getArtifactText(run.runId, call.resultRef)
                    : null,
                })),
              },
              null,
              2,
            ),
          ),
        });
      }
      throw error;
    } finally {
      await rm(original, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
