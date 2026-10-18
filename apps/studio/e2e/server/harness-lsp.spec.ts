import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { linearCorral } from '@corral/testkit';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true });
test('[TC-HAR-010-H] registers and selects a language server, approves an SDK query and trusts its fingerprint', async ({
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
    const protocol = createRequire(
      new URL('../../../server/package.json', import.meta.url),
    ).resolve('vscode-languageserver-protocol/node');
    writeFileSync(
      join(source, 'lsp.mjs'),
      readFileSync(
        new URL('../../../server/test/fixtures/lsp-server.mjs', import.meta.url),
        'utf8',
      ).replace(
        "'vscode-languageserver-protocol/node'",
        JSON.stringify(pathToFileURL(protocol).href),
      ),
    );
    writeFileSync(join(source, 'main.ts'), 'const n = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    await corral.open('/settings?section=workspace');
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
    }, source);
    await page.reload();
    await page.getByLabel('Language server ID', { exact: true }).fill('typescript');
    await page.getByLabel('Language server name', { exact: true }).fill('Fixture server');
    await page
      .getByLabel('Language server command and arguments', { exact: true })
      .fill('node\nlsp.mjs');
    await page.getByLabel('Language IDs', { exact: true }).fill('typescript');
    await page.getByLabel('File extensions', { exact: true }).fill('.ts');
    await page.getByRole('button', { name: 'Save language server', exact: true }).click();
    await expect(page.getByText('Saved project tools revision 1', { exact: true })).toBeVisible();
    await page.goto(`${corral.server.url}/settings/harness`);
    await page.getByLabel('Work style name', { exact: true }).fill('LSP writer');
    await page.getByLabel('Select language servers for this style', { exact: true }).check();
    await page.getByLabel('Use language server Fixture server', { exact: true }).check();
    await page.getByRole('button', { name: 'Save work style', exact: true }).click();
    await expect(page.getByTestId('harness-status')).toContainText('Saved revision 1');
    await page.getByRole('button', { name: 'Preview effective settings', exact: true }).click();
    await expect(page.getByTestId('harness-preview')).toContainText('typescript');
    corral.fake?.answerWith('Definition found.', {
      lspQuery: {
        serverId: 'typescript',
        operation: 'definition',
        path: 'main.ts',
        position: { line: 0, character: 6 },
      },
    });
    const definition = linearCorral(['writer']);
    definition.roles[0]!.modelProfile = 'model-b';
    definition.roles[0]!.allowedWorkTools.push('read_file');
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
      const profile = profiles.find((p: { name: string }) => p.name === 'LSP writer');
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
    await expect(page.getByText('node lsp.mjs', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run this query once', exact: true }).click();
    await expect(page.getByTestId('run-status').first()).toContainText('Succeeded');
    await page.goto(`${corral.server.url}/settings?section=workspace`);
    await page
      .getByRole('button', { name: 'Review launch for Fixture server', exact: true })
      .click();
    await page.getByRole('button', { name: 'Trust this launch', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Revoke launch trust', exact: true }),
    ).toBeVisible();
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
