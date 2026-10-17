import definition from '../../../../examples/research-team.corral.json' with { type: 'json' };
import layout from '../../../../examples/research-team.layout.json' with { type: 'json' };
import { expect, test } from './harness.ts';

test('[TC-HAR-014-H] pins a review recipe in the Loop editor and explains its stop in the Run and Inbox', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const ids = await page.evaluate(
    async ({ definition, layout }) => {
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
        layout: { nodes: layout.nodes, viewport: layout.viewport },
      });
      const session = await call('/sessions', {
        projectId: 'default',
        corralId: saved.record.corralId,
        title: 'Recipe review',
      });
      return { corralId: saved.record.corralId, sessionId: session.session.sessionId };
    },
    { definition, layout },
  );
  await page.goto(`${corral.server.url}/corrals/${ids.corralId}/edit`);
  await page
    .locator('.react-flow__node[data-id="review_loop"]')
    .getByText('검토 반복', { exact: true })
    .click();
  await page.getByLabel('Maximum generation attempts', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Pin review recipe', exact: true }).click();
  await expect(page.getByText('Pinned recipe revision 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const runId = await page.evaluate(async ({ corralId, sessionId }) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const record = await (await fetch(`/api/v1/corrals/${corralId}`)).json();
    if (
      !record.definition.nodes.find((node: { id: string }) => node.id === 'review_loop')
        .reviewRecipe
    )
      throw new Error('recipe was not saved');
    const response = await fetch('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        schemaVersion: '0.1',
        commandId: 'recipe-run',
        corralId,
        definitionRevision: record.definitionRevision,
        sessionId,
        mode: 'mock',
      }),
    });
    if (!response.ok) throw new Error(`run: ${response.status}`);
    return (await response.json()).runId;
  }, ids);
  await page.goto(`${corral.server.url}/runs/${runId}?view=run`);
  await expect(page.getByTestId('run-status').first()).toContainText('Failed');
  await expect(page.getByTestId('recipe-status')).toContainText('Generation attempt limit reached');
  await expect(page.getByTestId('recipe-status')).toContainText('Revise');
  await page.goto(`${corral.server.url}/`);
  await expect(
    page.getByText('Review stopped: Generation attempt limit reached', { exact: false }),
  ).toBeVisible();
  expect(corral.errors).toEqual([]);
});
