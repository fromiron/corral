import type { Page } from '@playwright/test';
import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

// The Results view against the local server.

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
  const picker = page.getByRole('banner').getByRole('combobox', { name: 'Selected run' });
  await picker.click();
  await page.getByRole('option', { name: /Run #1/ }).click();
  await expect(page.getByRole('link', { name: /Selected run · Run #1 of 2/ })).toBeVisible();
  await page.reload();
  await expect(picker).toContainText('Run #1');
  await expect(page.getByTestId('composer-stats').locator('summary')).toHaveText(totals);
  await page.getByTestId('session-summary-trigger').click();
  const overview = page.getByTestId('session-summary-popup');
  await expect(overview.getByTestId('overview-run-scope')).toHaveText('Selected run · Run #1');
  const first = [...corral.server.coordinator.listRuns()].reverse()[0];
  if (!first) throw new Error('The first run is missing');
  const { projection } = corral.server.coordinator.getSnapshot(first.runId);
  await expect(overview.locator('[data-overview-widget="usage"]')).toContainText(
    projection.budget.spent.toLocaleString('en-US'),
  );
  await overview.getByRole('button', { name: 'Open Usage details' }).click();
  await expect(page.getByTestId('usage-detail')).toContainText('Settled output tokens');
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
  await expect(
    results.getByRole('option', { name: /Run #2 · Helper · execution 2/ }),
  ).toBeVisible();
  await expect(
    results.getByRole('option', { name: /Run #2 · Helper · execution 3/ }),
  ).toBeVisible();
  expect(corral.errors).toEqual([]);
});

function handle(page: Page, nodeId: string, port: string) {
  return page.locator(
    `.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${port}"]`,
  );
}

/** A one-agent Corral run to its end, then its Run page. */
async function finishedRun(page: Page) {
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.getByRole('button', { name: 'New team' }).click();
  await expect(page).toHaveURL(/\/corrals\/corral_[a-z0-9]+\/edit/);
  await page.getByRole('button', { name: 'Add Agent' }).click();
  await page.getByRole('button', { name: 'Add Output' }).click();
  await handle(page, 'agent_1', 'out').dragTo(handle(page, 'output_1', 'in'));
  await expect(page.getByText('Ready to run.')).toBeVisible();
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 15_000 });
  await expect(page.getByRole('tab', { name: 'Test run', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('link', { name: 'Open execution page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_[a-f0-9]+/);
  await expect(page.getByRole('tab', { name: 'Graph', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByTestId('run-monitor')
    .getByRole('button', { name: 'Results', exact: true })
    .click();
}

test('the Results view opens its result, and a reload keeps the chosen version', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await finishedRun(page);
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
    await page.evaluate(() => {
      const seen: unknown[] = [];
      (window as unknown as { seen: unknown[] }).seen = seen;
      window.addEventListener('message', (event) => seen.push(event.data));
    });
    await finishedRun(page);
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
