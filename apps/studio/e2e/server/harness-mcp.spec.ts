import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oauthFixture } from '../../../server/test/fixtures/mcp-oauth.ts';
import { expect, test } from './harness.ts';

test.use({ live: true });
test('[TC-HAR-016-H] reviews an MCP server, completes local OAuth and pins its role selection', async ({
  page,
  corral,
}) => {
  const source = mkdtempSync(join(tmpdir(), 'corral-mcp-ui-'));
  const fixture = await oauthFixture();
  try {
    execFileSync('git', ['init', '-q', source]);
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
        if (!response.ok) throw new Error('setup failed');
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
    await page.getByRole('button', { name: 'Revoke launch trust', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out of Local docs', exact: true }).click();
    await expect(page.getByText('Sign-in required', { exact: true })).toBeVisible();
    expect(corral.errors).toEqual([]);
  } finally {
    await fixture.close();
    rmSync(source, { recursive: true, force: true });
  }
});
