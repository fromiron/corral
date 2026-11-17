import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import { usageTotals } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { reportedInput } from '../../../../packages/react/src/run/usage-input.ts';
import {
  activityLine,
  chooseRun,
  closePanel,
  lastRunSucceeded,
  newConversation,
  openPanelTab,
  openResult,
  panelTabNamed,
  requestBox,
} from '../workbench.ts';
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
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  const run = corral.server.coordinator.listRuns()[0];
  assert(run);
  const failed = Object.values(
    corral.server.coordinator.getSnapshot(run.runId).projection.toolCalls,
  ).find((tool) => tool.errorCode === 'TARGET_NOT_FOUND');
  assert(failed);
  // chat-widgets-contract: a completed run's failed-steps notice shows once, in its turn, beside
  // those steps; nothing above the input repeats it or counts the steps as items to answer.
  // The run row's head counts the failed steps; the steps are in the log the head opens.
  const head = page.locator('[data-chat-part="head"]');
  await expect(head).toContainText(/\d+ failed/);
  await head.getByRole('button', { expanded: false }).click();
  const tools = page.getByRole('list', { name: /^Tools · \d+$/ });
  await expect(tools).toContainText('The run completed, but some tool steps failed.');
  await expect(activityLine(page)).not.toContainText('some tool steps failed');
  await expect(activityLine(page)).not.toContainText('A failure needs attention');
  // Each helper's list_files failed the same way; the first one stands for them.
  const step = tools.getByRole('listitem').filter({ hasText: 'list_files' }).first();
  await expect(
    step.getByText('The requested file, folder, or target is unavailable.'),
  ).toBeVisible();
  await expect(step.locator('details')).not.toHaveAttribute('open');
  await step.getByText('Diagnostics', { exact: true }).click();
  await expect(step.locator('details code')).toHaveText(
    'TARGET_NOT_FOUND: the folder is unavailable',
  );
  // The run record keeps the same reasons on the execution that failed.
  await openPanelTab(page, 'Runs');
  await page
    .getByTestId('run-monitor')
    .getByRole('tablist', { name: 'Run views', exact: true })
    .getByRole('tab', { name: 'Workflow', exact: true })
    .click();
  await page
    .getByTestId('run-work-flow')
    .getByRole('button', { name: new RegExp(` · ${failed.executionId}`) })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`execution=${failed.executionId}`));
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

test('a past run’s usage reads in its Run info while the conversation keeps the last run, through reload and without changing session totals', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await newConversation(page);
  for (const [index, text] of ['First scope check', 'Second scope check'].entries()) {
    await requestBox(page).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('composer-stats')).toContainText(
      text.startsWith('First') ? '1 run' : '2 runs',
    );
    // The newest run is the last run; its turn, not the activity bar, names its number.
    await expect(lastRunSucceeded(page)).toContainText('Last run');
    await expect(activityLine(page)).not.toContainText(`Run #${index + 1}`);
    await expect(page.getByTestId('turn-run').last()).toHaveText(`Run #${index + 1}`);
  }
  // The same reading the comparison below makes: the figures wrap, so the laid-out text differs.
  const totals = (await page.getByTestId('composer-stats').textContent()) ?? '';
  expect(totals).toContain('Conversation total');
  // The run segment of the top bar's path shows while a run tab is selected.
  await openPanelTab(page, 'Runs');
  await chooseRun(page, 1);
  // The address selects Run #1's tab beside the conversation; the conversation still speaks of
  // the last run (chat-widgets-contract.md 3.1), and so it does after a reload.
  expect(new URL(page.url()).searchParams.get('run')).toBeTruthy();
  await expect(lastRunSucceeded(page)).toContainText('Last run');
  await expect(activityLine(page)).not.toContainText('Selected run');
  await page.reload();
  await expect(lastRunSucceeded(page)).toContainText('Last run');
  await expect(activityLine(page)).not.toContainText('Selected run');
  await expect(page.getByTestId('composer-stats')).toHaveText(totals);
  const [first, second] = [...corral.server.coordinator.listRuns()].reverse();
  if (!first || !second) throw new Error('The runs are missing');
  const { projection } = corral.server.coordinator.getSnapshot(first.runId);
  const last = corral.server.coordinator.getSnapshot(second.runId).projection;
  // Overview reads the last run's usage and names no other run's scope.
  await page.getByTestId('session-summary-trigger').click();
  const overview = page.getByTestId('session-summary-popup');
  await expect(overview.getByTestId('overview-run-scope')).toHaveCount(0);
  await expect(overview).not.toContainText('Selected run');
  await expect(overview.locator('[data-overview-widget="usage"]')).toContainText(
    usageTotals(last).outputTokens.toLocaleString('en-US'),
  );
  await overview.getByRole('button', { name: 'Open Usage details' }).click();
  await expect(page.getByTestId('usage-detail')).toContainText('Reported output tokens');
  await expect(page.getByTestId('usage-detail')).toContainText('Simulation usage');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // The past run's own usage, its input and cached input with it, reads in its Run info: the
  // reload brought back Run #1's tab, selected.
  await expect(panelTabNamed(page, 'Run #1')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('banner').getByRole('button', { name: /Run #1/ })).toBeVisible();
  await page.getByRole('button', { name: 'Run info', exact: true }).click();
  await page.getByTestId('run-side').getByRole('tab', { name: 'Usage', exact: true }).click();
  const usage = page.getByTestId('run-side').getByRole('region', { name: 'Usage', exact: true });
  const value = (label: string) =>
    usage
      .locator('dt', { hasText: new RegExp(`^${label}$`) })
      .locator('xpath=following-sibling::dd[1]');
  await expect(value('Output tokens')).toHaveText(
    usageTotals(projection).outputTokens.toLocaleString('en-US'),
  );
  // The same reading as the Overview's usage detail: one computation, read from the record.
  const { input, inputUnreported } = reportedInput(projection);
  if (input) {
    await expect(value('Reported input tokens')).toHaveText(input.tokens.toLocaleString('en-US'));
    await expect(value('Cached input')).toHaveText(
      input.cached == null
        ? 'Not reported'
        : input.cacheShare == null
          ? input.cached.toLocaleString('en-US')
          : `${input.cached.toLocaleString('en-US')} (${new Intl.NumberFormat('en-US', {
              style: 'percent',
              maximumFractionDigits: 0,
            }).format(input.cacheShare)})`,
    );
  } else {
    // No call reported input: no input total of 0.
    await expect(usage.locator('dt', { hasText: 'Reported input tokens' })).toHaveCount(0);
  }
  if (inputUnreported > 0)
    await expect(usage).toContainText(
      `${inputUnreported} completed call${inputUnreported === 1 ? '' : 's'} did not report input tokens`,
    );
  await closePanel(page);
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
  // A finished run keeps its final and step results (api-contract.md, 산출물 본문 수명): the
  // conversation's final reply and its helper's notes are both offered, each once.
  const kept = Object.values(current.artifacts).filter(
    (artifact) => artifact.bodyAvailable !== false,
  );
  expect(kept.length).toBeGreaterThan(0);
  await expect(results.getByRole('option')).toHaveCount(kept.length);
  for (const artifact of kept)
    await expect(
      results.getByRole('option').filter({ hasText: `${artifact.name} v${artifact.version} · ` }),
    ).toHaveCount(1);
  const option = results
    .getByRole('option')
    .filter({ hasText: `${result.name} v${result.version} · ` });
  await expect(option).toContainText('Run #2');
  await expect(option).toContainText(
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
  await expect(page.getByTestId('run-status')).toContainText('Completed', { timeout: 15_000 });
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
