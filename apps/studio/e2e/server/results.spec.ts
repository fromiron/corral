import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

// The Results view against the local server (CR-009, roadmap 21; WBTST-008/034).

function handle(page: Page, nodeId: string, port: string) {
  return page.locator(
    `.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${port}"]`,
  );
}

/** A one-agent Corral run to its end, then its Run page. */
async function finishedRun(page: Page) {
  await page.getByRole('button', { name: 'New Corral' }).click();
  await expect(page).toHaveURL(/\/corrals\/corral_[a-z0-9]+\/edit/);
  await page.getByRole('button', { name: 'Add Agent' }).click();
  await page.getByRole('button', { name: 'Add Output' }).click();
  await handle(page, 'agent_1', 'out').dragTo(handle(page, 'output_1', 'in'));
  await expect(page.getByText('Ready to run.')).toBeVisible();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 15_000 });
  await page.getByRole('link', { name: 'Open run page' }).click();
  await expect(page).toHaveURL(/\/runs\/run_[a-f0-9]+/);
}

test('[WBTST-008] a finished run opens on its result, and a reload keeps the chosen version', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await finishedRun(page);
  await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
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

  test('[WBTST-034] previews in a sandbox: styles apply, no script runs, nothing leaves', async ({
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
    await page.getByText('Source', { exact: true }).click();
    await expect(page.getByTestId('result-body').locator('pre')).toContainText('<script>');
    expect(await page.evaluate(() => document.body.dataset.ran)).toBeUndefined();
    // The harness fails the test if the tracker image was requested.
  });
});
