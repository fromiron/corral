import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linearCorral } from '@corral/testkit';
import { expect, test } from './harness.ts';

test.describe('extension input during an SDK run', () => {
  test.use({ live: true, codexLogin: true });
  test('[TC-HAR-007-H] answers a startup prompt through the Run view and records the applied snapshot', async ({
    page,
    corral,
  }) => {
    const source = mkdtempSync(join(tmpdir(), 'corral-extension-ui-'));
    try {
      writeFileSync(
        join(source, 'package.json'),
        JSON.stringify({
          name: 'ui-fixture',
          version: '1.0.0',
          pi: { extensions: ['./extension.ts'] },
        }),
      );
      writeFileSync(
        join(source, 'extension.ts'),
        `export default pi=>pi.on('session_start',async(_e,ctx)=>{ const ok=await ctx.ui.confirm('Continue the test run?','Only the local fake model is used.'); if(!ok) throw new Error('declined'); ctx.ui.notify('Input received.'); });`,
      );
      await corral.open('/settings/harness');
      const definition = linearCorral(['writer']);
      definition.roles[0]!.modelProfile = 'model-b';
      definition.roles[0]!.harness = { profileId: 'ui-test', revision: 1 };
      const runId = await page.evaluate(
        async ({ source, definition }) => {
          const { csrfToken } = await (await fetch('/api/v1/session')).json();
          const call = async (path: string, body: unknown, method = 'POST') => {
            const response = await fetch(`/api/v1${path}`, {
              method,
              headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
              body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error(`setup failed: ${path} ${response.status}`);
            return response.json();
          };
          const review = await call('/harness/reviews', { source, kind: 'local' });
          const resource = await call('/harness/resources', { reviewId: review.reviewId });
          await call(`/harness/resources/${resource.hash}/trust`, { trusted: true }, 'PUT');
          await call(
            '/harness/profiles/ui-test',
            {
              expectedRevision: 0,
              profile: {
                name: 'UI test',
                policy: 'trusted-native',
                resources: [
                  {
                    resourceHash: resource.hash,
                    entry: 'extension.ts',
                    kind: 'extension',
                    required: true,
                  },
                ],
                allowedTools: ['write_artifact', 'submit_result'],
                startupCommands: [],
              },
            },
            'PUT',
          );
          const saved = await call('/corrals', {
            definition,
            layout: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: {} },
          });
          const result = await call('/runs', {
            schemaVersion: '0.1',
            commandId: 'start-ui-test',
            corralId: saved.record.corralId,
            definitionRevision: saved.record.definitionRevision,
            mode: 'live',
          });
          return result.runId as string;
        },
        { source, definition },
      );
      corral.fake?.answerWith('The confirmed result.');
      await page.goto(`${corral.server.url}/runs/${runId}?view=run`);
      await expect(page.getByText('Continue the test run?', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.getByText('Input received.', { exact: false })).toBeVisible();
      await expect(page.getByTestId('run-status').first()).toContainText('Succeeded');
      await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
      expect(corral.errors).toEqual([]);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
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
    page.on('dialog', (dialog) => void dialog.accept());
    await corral.open('/settings/skills');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('combobox', { name: 'Add method', exact: true }).click();
    await page.getByRole('option', { name: 'Import folder', exact: true }).click();
    await page.getByLabel('Resource folder', { exact: true }).fill(source);
    await page.getByRole('button', { name: 'Review source', exact: true }).click();
    await expect(page.getByText('Review copy ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save to library', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Trust this content', exact: true }).click();
    await page.goto(`${corral.server.url}/settings/harness`);
    await page.getByLabel('Work style name', { exact: true }).fill('Evidence writer');
    await page.getByLabel('Use skill writing', { exact: true }).check();
    await page.getByLabel('Skill mode writing', { exact: true }).selectOption('mandatory');
    let failListOnce = true;
    await page.route('**/api/v1/harness/profile-management', async (route) => {
      if (failListOnce && route.request().method() === 'GET') {
        failListOnce = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'SCHEMA_INVALID', message: 'Injected list read failure' },
          }),
        });
      } else await route.fallback();
    });
    await page.getByRole('button', { name: 'Save work style', exact: true }).click();
    await expect(page.getByTestId('harness-status')).toContainText('Saved revision 1');
    await expect(page.getByRole('button', { name: 'Save work style', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Load saved list again', exact: true }).click();
    expect(
      await page.evaluate(
        async () => (await (await fetch('/api/v1/harness/profiles')).json()).length,
      ),
    ).toBe(1);
    await page.getByRole('button', { name: 'Preview effective settings', exact: true }).click();
    await expect(page.getByTestId('harness-preview')).toContainText('Always cite the source.');
    await page.getByLabel('Work style name', { exact: true }).fill('Unsaved change');
    await expect(
      page.getByRole('button', { name: 'Preview effective settings', exact: true }),
    ).toBeDisabled();
    await page.reload();
    await page.getByRole('button', { name: 'Evidence writer · r1', exact: true }).click();
    await expect(page.getByLabel('Use skill writing', { exact: true })).toBeChecked();
    await page.goto(`${corral.server.url}/settings/skills`);
    await page.getByRole('button', { name: /^writing/ }).click();
    await page.getByRole('button', { name: 'Edit a copy', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Source', exact: true })
      .fill(
        '---\nname: writing\ndescription: Write with sources.\n---\nAlways cite the revised source.',
      );
    await page.getByRole('button', { name: 'Review source', exact: true }).click();
    await page.getByRole('button', { name: 'Save to library', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Trust this content', exact: true }).click();
    await page.getByRole('combobox', { name: 'Configure usage for', exact: true }).click();
    await page.getByRole('option', { name: 'Evidence writer · r1', exact: true }).click();
    await page.getByLabel('Use in Evidence writer', { exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Confirm change', exact: true });
    await expect(confirm).toContainText('Replace 1 previous');
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByLabel('Use in Evidence writer', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Use in Evidence writer', { exact: true })).toBeFocused();
    await page.getByLabel('Use in Evidence writer', { exact: true }).click();
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText(/Editing from Evidence writer · r2/)).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Skill mode writing', exact: true }),
    ).toHaveValue('mandatory');
    const effective = await page.evaluate(async () => {
      const profile = (await (await fetch('/api/v1/harness/profiles')).json()).find(
        (p: { name: string }) => p.name === 'Evidence writer',
      );
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      return (
        await fetch('/api/v1/harness/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify({
            binding: { profileId: profile.profileId, revision: profile.revision },
            projectId: 'default',
          }),
        })
      ).json();
    });
    expect(effective.sections[0]?.text).toContain('Always cite the revised source.');

    await page.getByRole('button', { name: 'Remove from list', exact: true }).click();
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    await expect(page.getByLabel('Use in Evidence writer', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.reload();
    await page
      .getByRole('button', { name: /^writing/ })
      .filter({ hasText: 'Referenced by 1 work styles' })
      .click();
    await expect(page.getByText('Always cite the revised source.', { exact: false })).toBeVisible();

    expect(corral.errors).toHaveLength(1);
    expect(corral.errors[0]).toContain('500');
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
