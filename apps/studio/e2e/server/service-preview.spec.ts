import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import { panelTab, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true });

test('[TC-ABS-004-H] an owned service starts from the request, appears with its preview and stops with its run', async ({
  page,
  corral,
}, testInfo) => {
  test.skip(
    !process.env.CORRAL_BROWSER_EXECUTABLE || !['win32', 'linux'].includes(process.platform),
    'Requires an installed Chromium browser and supported process ownership.',
  );
  test.setTimeout(90_000);
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('Port unavailable'));
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const original = mkdtempSync(join(tmpdir(), 'corral-service-preview-e2e-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('init', '-q');
  writeFileSync(
    join(original, 'preview-app.cjs'),
    `
const http = require('node:http');
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<h1>Owned service is ready</h1>');
});
server.on('connection', socket => socket.on('error', () => {}));
setTimeout(() => server.listen(${port}, '127.0.0.1'), 500);
`,
  );
  git('add', '.');
  git('commit', '-q', '-m', 'local application');
  let operationId = '';
  let leaseId = '';
  const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
  const last = (messages: unknown): Record<string, unknown> => {
    const message = (messages as { role: string; content: { type: string; text?: string }[] }[]).at(
      -1,
    );
    if (message?.role !== 'toolResult') throw new Error('Tool result did not reach the model');
    return JSON.parse(
      message.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n'),
    );
  };
  corral.fake?.setResponses([
    tool('run_command', { command: 'node preview-app.cjs', mode: 'service', timeoutMs: 60000 }),
    (context) => {
      const started = last(context.messages);
      expect(started.state).toBe('running');
      operationId = String(started.operationId);
      return tool('preview_app', { operationId, port });
    },
    (context) => {
      const preview = last(context.messages);
      expect(preview.kind).toBe('service');
      leaseId = String(preview.leaseId);
      return tool('preview_action', { leaseId, tool: 'browser_snapshot', args: {} });
    },
    (context) => {
      expect(JSON.stringify(last(context.messages))).toContain('Owned service is ready');
      return tool('preview_action', {
        leaseId,
        tool: 'browser_verify_text_visible',
        args: { text: 'Owned service is ready' },
      });
    },
    (context) => {
      expect((last(context.messages).result as { isError?: boolean }).isError).not.toBe(true);
      return tool('ask_user', {
        key: 'service-preview',
        questions: [{ id: 'continue', kind: 'text', prompt: 'Keep the service running?' }],
      });
    },
  ]);
  try {
    // CR-055: a trusted folder's session runs commands in the built-in work style.
    await corral.open('/');
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
    await page.getByRole('combobox', { name: 'Permissions for next request', exact: true }).click();
    await page
      .getByRole('option')
      .filter({ has: page.getByText('Auto', { exact: true }) })
      .click();
    await requestBox(page).fill(
      'Start preview-app.cjs as a service, open its owned preview, verify the heading and ask me whether to keep it running.',
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('action-required')).toBeVisible({ timeout: 45_000 });
    await page.getByTestId('action-required').getByRole('link').click();
    await expect(page.getByRole('form', { name: 'Waiting for your answer' })).toContainText(
      'Keep the service running?',
    );
    await panelTab(page, 'Files');
    const previews = page.getByRole('region', { name: 'Open previews', exact: true });
    await expect(previews).toContainText('Local app');
    await expect(previews.getByRole('link', { name: 'View run', exact: true })).toBeVisible();
    const commands = page.getByTestId('worktree-command-panel');
    await expect(commands).toContainText('node preview-app.cjs');
    const prefix = `${corral.server.url}/api/v1/sessions/${sessionId}`;
    const leases = await (await page.request.get(`${prefix}/previews`)).json();
    expect(leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ leaseId, operationId, kind: 'service', state: 'ready' }),
      ]),
    );
    await page.screenshot({ path: testInfo.outputPath('service-preview.png') });
    await page
      .getByRole('region', { name: 'Request', exact: true })
      .getByRole('button', { name: 'Cancel whole run', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Cancel whole run', exact: true })
      .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
      .click();
    await expect
      .poll(async () => (await page.request.get(`${prefix}/processes/${operationId}`)).json(), {
        timeout: 30000,
      })
      .toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    await expect
      .poll(async () => (await page.request.get(`${prefix}/previews`)).json(), { timeout: 30000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ leaseId, state: 'stopped' })]));
    await expect(previews).toHaveCount(0);
  } catch (error) {
    const run = corral.server.coordinator.listRuns()[0];
    if (run) {
      const projection = corral.server.coordinator.getSnapshot(run.runId).projection;
      await testInfo.attach('service-preview-failure', {
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
