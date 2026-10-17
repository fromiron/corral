import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './harness.ts';
import { linearCorral } from '@corral/testkit';

test.describe('extension input during an SDK run', () => {
  test.use({ live: true, codexLogin: true });
  test('[TC-HAR-007-H] answers a startup prompt through the Run view and records the applied snapshot', async ({ page, corral }) => {
    const source = mkdtempSync(join(tmpdir(), 'corral-extension-ui-'));
    try {
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'ui-fixture', version: '1.0.0', pi: { extensions: ['./extension.ts'] } }));
      writeFileSync(join(source, 'extension.ts'), `export default pi=>pi.on('session_start',async(_e,ctx)=>{ const ok=await ctx.ui.confirm('Continue the test run?','Only the local fake model is used.'); if(!ok) throw new Error('declined'); ctx.ui.notify('Input received.'); });`);
      await corral.open('/settings/harness');
      const definition = linearCorral(['writer']);
      definition.roles[0]!.modelProfile = 'model-b';
      definition.roles[0]!.harness = { profileId: 'ui-test', revision: 1 };
      const runId = await page.evaluate(async ({ source, definition }) => {
        const { csrfToken } = await (await fetch('/api/v1/session')).json();
        const call = async (path: string, body: unknown, method = 'POST') => {
          const response = await fetch(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken }, body: JSON.stringify(body) });
          if(!response.ok) throw new Error(`setup failed: ${path} ${response.status}`);
          return response.json();
        };
        const review = await call('/harness/reviews', { source, kind: 'local' });
        const resource = await call('/harness/resources', { reviewId: review.reviewId });
        await call(`/harness/resources/${resource.hash}/trust`, { trusted: true }, 'PUT');
        await call('/harness/profiles/ui-test', { expectedRevision: 0, profile: { name: 'UI test', policy: 'trusted-native', resources: [{ resourceHash: resource.hash, entry: 'extension.ts', kind: 'extension', required: true }], allowedTools: ['write_artifact','submit_result'], startupCommands: [] } }, 'PUT');
        const saved = await call('/corrals', { definition, layout: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: {} } });
        const result = await call('/runs', { schemaVersion: '0.1', commandId: 'start-ui-test', corralId: saved.record.corralId, definitionRevision: saved.record.definitionRevision, mode: 'live' });
        return result.runId as string;
      }, { source, definition });
      corral.fake?.answerWith('The confirmed result.');
      await page.goto(`${corral.server.url}/runs/${runId}?view=run`);
      await expect(page.getByText('Continue the test run?', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.getByText('Input received.', { exact: false })).toBeVisible();
      await expect(page.getByTestId('run-status').first()).toContainText('Succeeded');
      await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
      expect(corral.errors).toEqual([]);
    } finally { rmSync(source, { recursive: true, force: true }); }
  });
});

test('[TC-HAR-004-H] install, trust, save and preview a mandatory skill through Settings', async ({
  page,
  corral,
}) => {
  const source = mkdtempSync(join(tmpdir(), 'corral-skill-ui-'));
  try {
    mkdirSync(join(source, 'skills', 'writing'), { recursive: true });
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'writing-pack',
        version: '1.0.0',
        license: 'MIT',
        pi: { skills: ['./skills'] },
      }),
    );
    writeFileSync(
      join(source, 'skills', 'writing', 'SKILL.md'),
      '---\nname: writing\ndescription: Write with sources.\n---\nAlways cite the source.',
    );
    await corral.open('/settings/harness');
    await expect(page.getByRole('heading', { name: 'Work styles', exact: true })).toBeVisible();
    await page.getByLabel('Resource source').fill(source);
    await page.getByRole('button', { name: 'Review source', exact: true }).click();
    await expect(page.getByText('writing-pack · 1.0.0', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Install reviewed copy', exact: true }).click();
    const resource = page.getByTestId('resource-writing-pack');
    await expect(resource).toContainText('Not trusted');
    await resource.getByRole('button', { name: 'Trust this content', exact: true }).click();
    await page.getByLabel('Work style name', { exact: true }).fill('Evidence writer');
    await page.getByLabel('Use skill writing', { exact: true }).check();
    await page.getByLabel('Skill mode writing', { exact: true }).selectOption('mandatory');
    await page.getByRole('button', { name: 'Save work style', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved revision 1');
    await page.getByRole('button', { name: 'Preview effective settings', exact: true }).click();
    await expect(page.getByTestId('harness-preview')).toContainText('Always cite the source.');
    await page.reload();
    await page
      .getByLabel('Saved work style', { exact: true })
      .selectOption({ label: 'Evidence writer · r1' });
    await expect(page.getByLabel('Use skill writing', { exact: true })).toBeChecked();
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
