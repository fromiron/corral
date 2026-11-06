import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

// The Results view against the local server.

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
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
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
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('run-monitor').getByRole('tab', { name: 'Results', exact: true }).click();
}

test('the Results view opens its result, and a reload keeps the chosen version', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await finishedRun(page, corral);
  await expect(page).toHaveURL(/view=results/);
  await expect(page.getByTestId('result-body')).toContainText('Agent 1 (agent_1) turn 2');
  const results = page.getByRole('navigation', { name: 'Results' });
  // One agent, one Output: a single final result.
  await expect(
    results.getByRole('region', { name: 'Final results' }).getByRole('button'),
  ).toHaveCount(1);
  await results.getByRole('region', { name: 'Final results' }).getByRole('button').click();
  await expect(page).toHaveURL(/view=results&result=/);
  await page.reload();
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
    await page.getByRole('radio', { name: 'Source', exact: true }).click();
    await expect(page.getByTestId('result-body').locator('pre')).toContainText('<script>');
    expect(await page.evaluate(() => document.body.dataset.ran)).toBeUndefined();
    // The harness fails the test if the tracker image was requested.
  });
});
