import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linearCorral } from '@corral/testkit';
import { oauthFixture } from '../../../server/test/fixtures/mcp-oauth.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true });
test('[TC-HAR-016-H] reviews an MCP server, completes local OAuth and pins its role selection', async ({
  page,
  corral,
}) => {
  const source = mkdtempSync(join(tmpdir(), 'corral-mcp-ui-'));
  const fixture = await oauthFixture();
  try {
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ]);
    // A loaded document can precede completion of the asynchronous session bootstrap.
    await page.route('**/api/v1/session', async (route) => {
      if (route.request().method() === 'POST')
        await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fallback();
    });
    await corral.open('/settings/harness');
    await page.evaluate(async (source) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      for (const [method, body] of [
        ['PUT', { path: source }],
        ['PATCH', { trusted: true }],
      ] as const) {
        const response = await fetch('/api/v1/projects/default/workspace', {
          method,
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`setup ${method}: ${response.status}`);
      }
    }, source);
    await page.reload();
    await page.getByLabel('MCP server ID', { exact: true }).fill('docs');
    await page.getByLabel('MCP server name', { exact: true }).fill('Local docs');
    await page.getByRole('combobox', { name: 'MCP transport', exact: true }).selectOption('http');
    await page.getByLabel('MCP endpoint', { exact: true }).fill(fixture.url);
    await page
      .getByRole('combobox', { name: 'MCP authentication', exact: true })
      .selectOption('oauth');
    await page.getByLabel('Credential reference', { exact: true }).fill('docs-login');
    await page.getByLabel('OAuth scopes', { exact: true }).fill('docs:read');
    await page.getByRole('button', { name: 'Save MCP server', exact: true }).click();
    await expect(page.getByText('Saved project tools revision 1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Review launch for Local docs', exact: true }).click();
    await page.getByRole('button', { name: 'Trust this launch', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in to Local docs', exact: true }).click();
    const popup = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Continue sign-in', exact: true }).click();
    const callback = await popup;
    await expect(page.getByText('Credentials saved', { exact: true })).toBeVisible();
    await callback.close();
    await page.getByLabel('Work style name', { exact: true }).fill('MCP writer');
    await page
      .getByRole('combobox', { name: 'Policy', exact: true })
      .selectOption('trusted-native');
    await page.getByLabel('Select MCP servers for this style', { exact: true }).check();
    await page.getByLabel('Use MCP server Local docs', { exact: true }).check();
    await page.getByText('Allowed tool names', { exact: true }).first().click();
    await page
      .getByRole('textbox', { name: 'Allowed tool names', exact: true })
      .fill('write_artifact, submit_result, mcp__docs__echo');
    await page.getByRole('button', { name: 'Save work style', exact: true }).click();
    await page.getByRole('button', { name: 'Preview effective settings', exact: true }).click();
    await expect(page.getByTestId('harness-preview')).toContainText('MCP servers: docs');
    corral.fake?.answerWith('MCP completed.', { mcpCall: { name: 'mcp__docs__echo', args: {} } });
    const definition = linearCorral(['writer']);
    definition.roles[0]!.modelProfile = 'model-b';
    const ids = await page.evaluate(async (definition) => {
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
      const profiles = await (await fetch('/api/v1/harness/profiles')).json();
      const profile = profiles.find((p: { name: string }) => p.name === 'MCP writer');
      definition.roles[0]!.harness = { profileId: profile.profileId, revision: profile.revision };
      const session = await call('/sessions', { projectId: 'default', title: 'MCP work' });
      const sessionId = session.session.sessionId;
      await call(`/sessions/${sessionId}/worktree`, {});
      const saved = await call('/corrals', {
        definition,
        layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      });
      const started = await call('/runs', {
        schemaVersion: '0.1',
        commandId: 'mcp-run',
        corralId: saved.record.corralId,
        definitionRevision: 1,
        sessionId,
        mode: 'live',
      });
      return { runId: started.runId };
    }, definition);
    await page.goto(`${corral.server.url}/runs/${ids.runId}?view=run`);
    await expect(page.getByTestId('run-status').first()).toContainText('Succeeded');
    expect(fixture.mcpCalls).toBe(1);
    await page.goto(`${corral.server.url}/settings/harness`);
    await page.getByRole('button', { name: 'Review launch for Local docs', exact: true }).click();

    await page.getByRole('button', { name: 'Revoke launch trust', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out of Local docs', exact: true }).click();
    await expect(page.getByText('Sign-in required', { exact: true })).toBeVisible();
    expect(corral.errors).toEqual([]);
  } finally {
    await fixture.close();
    rmSync(source, { recursive: true, force: true });
  }
});
