import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import { usageTotals } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { chooseRun, openResult, panelTab, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

// The Results view against the local server.

test('a completed run explains failed file steps and opens their reasons', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const { csrfToken } = await (
    await page.request.get(`${corral.server.url}/api/v1/session`)
  ).json();
  const cookie = (await page.context().cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const call: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', corral.server.url);
    headers.set('cookie', cookie);
    headers.set('x-corral-csrf', csrfToken);
    return fetch(url, { ...init, headers });
  };
  const options = { baseUrl: corral.server.url, fetch: call };
  const repository = new RestCorralRepository(options);
  const workspaces = new WorkspacesApi(options);
  const original = join(corral.workspace, 'source');
  mkdirSync(original);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
      { cwd: original },
    );
  git('init', '-q');
  writeFileSync(join(original, 'README.md'), 'Example project\n');
  git('add', '.');
  git('commit', '-qm', 'Fixture');
  await workspaces.bind('default', original);
  await workspaces.configure('default', { trusted: true });
  const created = await repository.createSession({
    projectId: 'default',
    title: 'Failure context',
  });
  assert(created.ok);
  await workspaces.createWorktree(created.session.sessionId);
  await page.goto(`${corral.server.url}/sessions/${created.session.sessionId}`);
  await requestBox(page).fill('Write project notes');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const banner = page.getByTestId('action-required');
  await expect(banner).toContainText('The run completed, but some tool steps failed.');
  const run = corral.server.coordinator.listRuns()[0];
  assert(run);
  expect(run.status).toBe('succeeded');
  const failed = Object.values(
    corral.server.coordinator.getSnapshot(run.runId).projection.toolCalls,
  ).find((tool) => tool.errorCode === 'TARGET_NOT_FOUND');
  assert(failed);
  await page.goto(
    `${corral.server.url}/sessions/${created.session.sessionId}?run=${run.runId}&atSeq=1`,
  );
  await banner.getByRole('link', { name: 'Review failed steps' }).click();
  await expect(page).toHaveURL(new RegExp(`execution=${failed.executionId}`));
  await expect(page).not.toHaveURL(/atSeq=/);
  const failure = page.getByTestId(`failed-step-${failed.toolCallId}`);
  await expect(failure).toContainText('list_files');
  await expect(
    failure.getByText('The requested file, folder, or target is unavailable.'),
  ).toBeVisible();
  await expect(failure.locator('details')).not.toHaveAttribute('open');
  await failure.getByText('Diagnostics', { exact: true }).click();
  await expect(failure.locator('code')).toHaveText('TARGET_NOT_FOUND: the folder is unavailable');
  await page.getByRole('button', { name: 'Run info', exact: true }).click();
  await page.getByTestId('run-side').getByRole('tab', { name: 'Usage', exact: true }).click();
  await page.getByRole('button', { name: 'Usage by request' }).click();
  const request = page.locator('[data-testid^="usage-call-"]').first();
  await expect(request.locator('span').first()).toContainText('Request 1');
  await expect(request.locator('span').first()).not.toContainText('call_');
  await expect(request.locator('details')).not.toHaveAttribute('open');
  expect(corral.errors).toEqual([]);
});

test('selected-run usage and unique result identities survive reload without changing session totals', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  for (const [index, text] of ['First scope check', 'Second scope check'].entries()) {
    await requestBox(page).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('composer-stats')).toContainText(
      text.startsWith('First') ? '1 turn' : '2 turns',
    );
    await expect(
      page.getByRole('link', { name: `Succeeded Last run · Run #${index + 1}`, exact: true }),
    ).toBeVisible();
  }
  const totals = await page.getByTestId('composer-stats').locator('summary').innerText();
  expect(totals).toContain('Session total');
  // The run segment of the top bar's path exists only in run history.
  await panelTab(page, 'Runs');
  await chooseRun(page, 1);
  await panelTab(page, 'Conversation');
  const selected = page.getByRole('link', { name: /Selected run · Run #1 of 2/ });
  await expect(selected).toBeVisible();
  await page.reload();
  await expect(selected).toBeVisible();
  await expect(page.getByTestId('composer-stats').locator('summary')).toHaveText(totals);
  await page.getByTestId('session-summary-trigger').click();
  const overview = page.getByTestId('session-summary-popup');
  await expect(overview.getByTestId('overview-run-scope')).toHaveText('Selected run · Run #1');
  const first = [...corral.server.coordinator.listRuns()].reverse()[0];
  if (!first) throw new Error('The first run is missing');
  const { projection } = corral.server.coordinator.getSnapshot(first.runId);
  await expect(overview.locator('[data-overview-widget="usage"]')).toContainText(
    usageTotals(projection).outputTokens.toLocaleString('en-US'),
  );
  await overview.getByRole('button', { name: 'Open Usage details' }).click();
  await expect(page.getByTestId('usage-detail')).toContainText('Reported output tokens');
  await expect(page.getByTestId('usage-detail')).toContainText('Simulation usage');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await requestBox(page).fill('@');
  const results = page
    .getByRole('listbox', { name: 'References' })
    .getByRole('group', { name: 'Results' });
  await expect(results.getByRole('option').first()).toContainText('Run #2');
  const names = await results.getByRole('option').allTextContents();
  expect(new Set(names).size).toBe(names.length);
  // Only the current result body is offered; older relation metadata is retained
  // for history without presenting a reference whose body has been released.
  const latest = corral.server.coordinator.listRuns()[0];
  assert(latest);
  const current = corral.server.coordinator.getSnapshot(latest.runId).projection;
  const latestId = current.output?.artifactVersionIds[0];
  const previousId = projection.output?.artifactVersionIds[0];
  assert(latestId && previousId);
  expect(latestId).not.toBe(previousId);
  const result = current.artifacts[latestId];
  assert(result);
  expect(current.executionOrder).toContain(result.authorExecutionId);
  await expect(results.getByRole('option')).toHaveCount(1);
  await expect(results.getByRole('option')).toContainText(`${result.name} v${result.version}`);
  await expect(results.getByRole('option')).toContainText('Run #2');
  await expect(results.getByRole('option')).toContainText(
    `execution ${current.executionOrder.indexOf(result.authorExecutionId) + 1}`,
  );
  expect(projection.artifacts[previousId]?.bodyAvailable).toBe(false);
  expect(projection.artifacts[previousId]?.authorExecutionId).toBeTruthy();
  await expect(results.getByRole('option').filter({ hasText: 'Run #1' })).toHaveCount(0);
  expect(corral.errors).toEqual([]);
});

/** A saved one-agent Corral run, without rebuilding an unrelated graph through the UI. */
async function finishedRun(page: Page, corral: { open(path?: string): Promise<void> }) {
  const definition = linearCorral(['agent_1']);
  definition.roles = definition.roles.map((role) => ({ ...role, name: 'Agent 1' }));
  definition.nodes = definition.nodes.map((node) =>
    node.id === 'agent_1' ? { ...node, label: 'Agent 1' } : node,
  );
  const runId = await page.evaluate(async (definition) => {
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
    const saved = await call('/corrals', {
      definition,
    });
    const session = (
      await call('/sessions', {
        projectId: 'default',
        title: 'Results fixture',
        corralId: saved.record.corralId,
      })
    ).session;
    const started = await call('/runs', {
      schemaVersion: '0.1',
      commandId: 'results-fixture',
      sessionId: session.sessionId,
      corralId: saved.record.corralId,
      definitionRevision: saved.record.definitionRevision,
      mode: 'mock',
    });
    return started.runId as string;
  }, definition);
  await corral.open(`/runs/${runId}`);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 15_000 });
  await expect(page.getByRole('group', { name: 'Run graph', exact: true })).toBeVisible();
  await openResult(page);
}

test('the Results view opens its result, and a reload keeps the chosen version', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await finishedRun(page, corral);
  await expect(page).toHaveURL(/result=artv_/);
  const selectedVersion = new URL(page.url()).searchParams.get('result');
  await expect(page.getByTestId('run-document')).toBeVisible();
  await expect(page.getByTestId('run-side')).toBeHidden();
  await expect(page.getByTestId('result-body')).toContainText('Agent 1 (agent_1) turn 2');
  const results = page.getByRole('navigation', { name: 'Results' });
  // One agent, one Output: a single final result.
  await expect(results.getByRole('button')).toHaveCount(1);
  await results.getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`result=${selectedVersion}`));
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`result=${selectedVersion}`));
  await expect(page.getByTestId('result-body')).toContainText('Agent 1 (agent_1) turn 2');
  expect(corral.errors).toEqual([]);
});

test.describe('an HTML result', () => {
  test.use({
    agentReply:
      '<!doctype html><html><head><style>h1 { color: rgb(200, 0, 0) }</style></head><body><h1>Generated page</h1><img alt="tracker" src="https://tracker.example/pixel.png"><script>window.parent.postMessage("script ran", "*"); document.body.dataset.ran = "yes";</script></body></html>',
  });

  test('previews in a sandbox: styles apply, no script runs, nothing leaves', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    await page.addInitScript(() => {
      const seen: unknown[] = [];
      (window as unknown as { seen: unknown[] }).seen = seen;
      window.addEventListener('message', (event) => seen.push(event.data));
    });
    await finishedRun(page, corral);
    const frame = page.locator('iframe[title^="Preview of"]');
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(frame).toHaveAttribute('src', /\/artifact-versions\/[^/]+\/preview$/);
    const heading = page.frameLocator('iframe[title^="Preview of"]').getByRole('heading', {
      name: 'Generated page',
    });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS('color', 'rgb(200, 0, 0)');
    await expect(
      page.frameLocator('iframe[title^="Preview of"]').locator('body'),
    ).not.toHaveAttribute('data-ran', 'yes');
    expect(await page.evaluate(() => (window as unknown as { seen: unknown[] }).seen)).toEqual([]);

    // The source is the text as written; Studio's own page runs none of it.
    await page.getByRole('tab', { name: 'Source', exact: true }).click();
    await expect(page.getByTestId('result-body').locator('pre')).toContainText('<script>');
    expect(await page.evaluate(() => document.body.dataset.ran)).toBeUndefined();
    // The harness fails the test if the tracker image was requested.
  });
});
