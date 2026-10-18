import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linearCorral } from '@corral/testkit';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true });
test('[TC-HAR-012-H] selects a registered check, approves its SDK call and reads the owned verification report', async ({
  page,
  corral,
}) => {
  const source = mkdtempSync(join(tmpdir(), 'corral-check-ui-'));
  try {
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
        { cwd: source },
      );
    git('init', '-q');
    writeFileSync(join(source, 'check.mjs'), "console.log('Types passed');");
    git('add', '.');
    git('commit', '-qm', 'fixture');
    await corral.open('/settings/harness');
    await page.evaluate(async (source) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const call = async (path: string, body: unknown, method: string) => {
        const r = await fetch(`/api/v1${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`setup ${path}: ${r.status}`);
        return r.json();
      };
      await call('/projects/default/workspace', { path: source }, 'PUT');
      await call('/projects/default/workspace', { trusted: true }, 'PATCH');
      await call(
        '/harness/projects/default/tools',
        {
          expectedRevision: 0,
          config: {
            checks: [{ id: 'types', name: 'Types', argv: ['node', 'check.mjs'], timeoutMs: 10000 }],
            lspServers: [],
          },
        },
        'PUT',
      );
    }, source);
    await page.reload();
    await page.getByLabel('Work style name', { exact: true }).fill('Checked writer');
    await page.getByLabel('Select registered checks for this style', { exact: true }).check();
    await page.getByLabel('Use check Types', { exact: true }).check();
    await page.getByRole('button', { name: 'Save work style', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved revision 1');
    await page.getByRole('button', { name: 'Preview effective settings', exact: true }).click();
    await expect(page.getByTestId('harness-preview')).toContainText('types');
    corral.fake?.answerWith('All checks passed.', { checkId: 'types' });
    const definition = linearCorral(['writer']);
    definition.roles[0]!.modelProfile = 'model-b';
    const ids = await page.evaluate(async (definition) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const call = async (path: string, body: unknown) => {
        const r = await fetch(`/api/v1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`setup ${path}: ${r.status}`);
        return r.json();
      };
      const profiles = await (await fetch('/api/v1/harness/profiles')).json();
      const profile = profiles.find((p: { name: string }) => p.name === 'Checked writer');
      definition.roles[0]!.harness = { profileId: profile.profileId, revision: profile.revision };
      const session = await call('/sessions', { projectId: 'default', title: 'Checked work' });
      const sessionId = session.session.sessionId;
      await call(`/sessions/${sessionId}/worktree`, {});
      const saved = await call('/corrals', {
        definition,
        layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      });
      const started = await call('/runs', {
        schemaVersion: '0.1',
        commandId: 'start-checked-writer',
        corralId: saved.record.corralId,
        definitionRevision: 1,
        sessionId,
        mode: 'live',
      });
      return { sessionId, runId: started.runId };
    }, definition);
    await page.goto(`${corral.server.url}/runs/${ids.runId}?view=run`);
    await expect(page.getByText('node check.mjs', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run this check once', exact: true }).click();
    await expect(page.getByTestId('run-status').first()).toContainText('Succeeded');
    const reports = await page.evaluate(
      async (sessionId) => (await fetch(`/api/v1/sessions/${sessionId}/verifications`)).json(),
      ids.sessionId,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      stale: false,
      report: {
        state: 'completed',
        verdict: 'pass',
        targetUnchanged: true,
        cleanupConfirmed: true,
        owner: { kind: 'execution', runId: ids.runId },
      },
    });
    await page.goto(`${corral.server.url}/settings/harness`);
    await page.getByRole('button', { name: 'Review launch for Types', exact: true }).click();
    await page.getByRole('button', { name: 'Trust this launch', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Revoke launch trust', exact: true }),
    ).toBeVisible();
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
