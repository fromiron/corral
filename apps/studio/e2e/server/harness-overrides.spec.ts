import { linearCorral } from '@corral/testkit';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true });
test('[TC-HAR-003-H] previews a run-only work style, uses its pinned layer and clears it after starting', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/harness');
  const definition = linearCorral(['writer']);
  definition.roles[0]!.modelProfile = 'model-b';
  definition.roles[0]!.harness = { profileId: 'base', revision: 1 };
  const corralId = await page.evaluate(async (definition) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, body: unknown, method = 'POST') => {
      const r = await fetch(`/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`setup ${path}: ${r.status}`);
      return r.json();
    };
    for (const id of ['base', 'limited'])
      await call(
        `/harness/profiles/${id}`,
        {
          expectedRevision: 0,
          profile: {
            name: id === 'base' ? 'Base style' : 'One-time style',
            policy: 'strict',
            allowedTools:
              id === 'base'
                ? ['write_artifact', 'submit_result', 'read']
                : ['write_artifact', 'submit_result'],
            resources: [],
            startupCommands: [],
          },
        },
        'PUT',
      );
    const saved = await call('/corrals', {
      definition,
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    });
    return saved.record.corralId;
  }, definition);
  corral.fake?.answerWith('Run override applied.');
  await page.goto(`${corral.server.url}/corrals/${corralId}/edit`);
  await page.getByText('Work styles for this run', { exact: true }).click();
  const select = page.getByLabel('Run work style for writer', { exact: true });
  await select.selectOption('limited:1');
  await page.getByRole('button', { name: 'Preview run style for writer', exact: true }).click();
  await expect(page.getByTestId('run-harness-preview')).toContainText('limited');
  await page.getByLabel('Agents').selectOption({ label: 'Live models (uses your sign-in)' });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status').first()).toContainText('Succeeded');
  await expect(select).toHaveValue('');
  const state = await page.evaluate(async () => {
    const runs = await (await fetch('/api/v1/runs')).json();
    return (await fetch(`/api/v1/runs/${runs[0].runId}`)).json();
  });
  expect(Object.values(state.harnesses)).toContainEqual(
    expect.objectContaining({
      allowedTools: ['write_artifact', 'submit_result'],
      layers: expect.arrayContaining([
        { scope: 'run', binding: { profileId: 'limited', revision: 1 } },
      ]),
    }),
  );
  const saved = await page.evaluate(
    async (id) => (await fetch(`/api/v1/corrals/${id}`)).json(),
    corralId,
  );
  expect(saved.definition.roles[0].harness).toEqual({ profileId: 'base', revision: 1 });
  expect(corral.errors).toEqual([]);
});
