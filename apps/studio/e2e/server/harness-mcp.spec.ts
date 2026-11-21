import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linearCorral } from '@corral/testkit';
import { oauthFixture } from '../../../server/test/fixtures/mcp-oauth.ts';
import {
  editorSettings,
  expectTeamSaved,
  lastRunSucceeded,
  maximizePanel,
  openFlowGraph,
  teamNode,
} from '../workbench.ts';
import { expect, test } from './harness.ts';

function initializeRepository(source: string) {
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
}

test.use({ live: true, codexLogin: true });
test('reviews an MCP server, completes local OAuth and pins its role selection', async ({
  page,
  corral,
}) => {
  const source = mkdtempSync(join(tmpdir(), 'corral-mcp-ui-'));
  const fixture = await oauthFixture();
  try {
    initializeRepository(source);
    // A loaded document can precede completion of the asynchronous session bootstrap.
    await page.route('**/api/v1/session', async (route) => {
      if (route.request().method() === 'POST')
        await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fallback();
    });
    await corral.open('/settings/mcp?projectId=missing');
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Settings for', exact: true }).click();
    await page.getByRole('option', { name: 'My project', exact: true }).click();
    await expect(page).toHaveURL(/settings=mcp&settingsProject=default/);
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
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByLabel('Server name', { exact: true }).fill('Local docs');
    await page.getByLabel('MCP endpoint', { exact: true }).fill(fixture.url);
    await page.getByRole('combobox', { name: 'MCP authentication', exact: true }).click();
    await page.getByRole('option', { name: 'OAuth', exact: true }).click();
    await page.getByLabel('OAuth scopes', { exact: true }).fill('docs:read');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('[role="dialog"]:not([data-settings-dialog])')).toHaveCount(0);
    await page.getByLabel('Enabled for this project', { exact: true }).check();
    await page.getByRole('button', { name: 'Review launch for Local docs', exact: true }).click();
    await page.getByRole('button', { name: 'Trust this launch', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in to Local docs', exact: true }).click();
    const popup = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Continue sign-in', exact: true }).click();
    const callback = await popup;
    await expect(page.getByText(/Sign-in: Credentials saved/)).toBeVisible();
    await callback.close();
    await page
      .getByRole('button', { name: 'Test connection & discover tools', exact: true })
      .click();
    await expect(page.getByText(/Connection checked at/)).toBeVisible();
    expect(fixture.mcpCalls).toBe(0);
    await page.goto(`${corral.server.url}/settings/harness?projectId=default`);
    await page.getByLabel('Harness name', { exact: true }).fill('MCP writer');
    await page.getByRole('combobox', { name: 'Policy', exact: true }).click();
    await page.getByRole('option', { name: 'Trusted native extensions', exact: true }).click();
    await page.getByRole('button', { name: 'Save Harness', exact: true }).click();
    await expect(page.getByTestId('harness-status')).toContainText('Saved revision 1');
    await page.goto(`${corral.server.url}/settings/mcp?projectId=default`);
    await page.getByRole('button', { name: /^Local docs/ }).click();
    await page.getByRole('link', { name: 'Connect a Harness', exact: true }).click();
    await page.getByRole('button', { name: 'MCP writer · r1', exact: true }).click();
    await page
      .getByRole('combobox', { name: 'Select MCP servers for this Harness', exact: true })
      .click();
    await page.getByRole('option', { name: 'Choose below', exact: true }).click();
    await page.getByLabel('Use MCP server Local docs', { exact: true }).check();
    await page
      .getByRole('button', { name: 'Test connection & discover tools', exact: true })
      .click();
    await page.getByLabel('echo', { exact: false }).check();
    expect(
      await page.evaluate(
        async () => (await (await fetch('/api/v1/harness/profiles')).json())[0].revision,
      ),
    ).toBe(1);
    await page.getByRole('button', { name: 'Save Harness', exact: true }).click();
    await expect(page.getByTestId('harness-status')).toContainText('Saved revision 2');
    const toolName = await page.evaluate(async () => {
      const config = await (await fetch('/api/v1/harness/projects/default/tools')).json();
      return `mcp__${config.mcpServers[0].id}__echo`;
    });
    corral.fake?.answerWith('MCP completed.', { mcpCall: { name: toolName, args: {} } });
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
    // Beside the conversation the record does not say the run's state; the conversation does.
    await expect(lastRunSucceeded(page)).toBeVisible();
    expect(fixture.mcpCalls).toBe(1);
    await page.goto(`${corral.server.url}/settings/mcp?projectId=default`);
    await page.getByRole('button', { name: /^Local docs/ }).click();
    await page.getByRole('button', { name: 'Review launch for Local docs', exact: true }).click();

    await page.getByRole('button', { name: 'Revoke launch trust', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out of Local docs', exact: true }).click();
    await expect(page.getByText(/Sign-in: Sign-in required/)).toBeVisible();
    expect(corral.errors).toEqual([]);
  } finally {
    await fixture.close();
    rmSync(source, { recursive: true, force: true });
  }
});

test('the Applied Harness shows only the MCP tool and connection saved for the seat', async ({
  page,
  corral,
}) => {
  const source = mkdtempSync(join(tmpdir(), 'corral-seat-mcp-'));
  const fixture = await oauthFixture();
  try {
    initializeRepository(source);
    await corral.open('/');
    const url = corral.server.url;
    const { csrfToken } = await (await page.request.get(`${url}/api/v1/session`)).json();
    const api = async (path: string, method = 'GET', data?: Record<string, unknown>) => {
      const response = await page.request.fetch(`${url}/api/v1${path}`, {
        method,
        headers: { origin: url, 'x-corral-csrf': csrfToken },
        ...(data ? { data } : {}),
      });
      await expect(response, `${method} ${path}`).toBeOK();
      return response.json();
    };

    // Only this project has the connections. The policy is deliberately broader than the seat.
    const { project } = await api('/projects', 'POST', { name: 'Issue investigation' });
    const projectId = project.projectId;
    const workspace = `/projects/${projectId}/workspace`;
    await api(workspace, 'PUT', { path: source });
    await api(workspace, 'PATCH', { trusted: true });
    const tools = `/harness/projects/${projectId}`;
    const servers = [
      { id: 'docs', name: 'Project docs' },
      { id: 'archive', name: 'Project archive' },
    ];
    await api(`${tools}/tools`, 'PUT', {
      expectedRevision: 0,
      config: {
        checks: [],
        lspServers: [],
        mcpServers: servers.map((server) => ({
          ...server,
          enabled: true,
          transport: 'http',
          url: fixture.url,
          auth: { kind: 'bearer', credentialRef: `${server.id}_login` },
          exposure: 'direct',
          timeoutMs: 5000,
        })),
      },
    });
    for (const { id } of servers) {
      const path = `${tools}/mcp-servers/${id}`;
      const { fingerprint } = await api(`${path}/launch`);
      await api(`${path}/trust`, 'PUT', { fingerprint, trusted: true });
      await api(`${path}/auth`, 'POST', {
        action: 'bearer',
        fingerprint,
        token: 'fixture-access-0',
      });
    }
    // Settings is a detour, not a navigation away from the private original or picker draft.
    await page.goto(`${url}/library/agents?project=${projectId}`);
    await page.getByRole('button', { name: 'Create agent', exact: true }).click();
    const original = page.getByRole('dialog', { name: 'Create agent', exact: true });
    await original.getByRole('textbox', { name: 'Name', exact: true }).fill('Private investigator');
    await original.getByRole('textbox', { name: 'Base instructions' }).fill('Investigate issues.');
    await original.getByRole('button', { name: 'Add tools' }).click();
    const originalPicker = page.getByRole('dialog', { name: 'Add tools', exact: true });
    await originalPicker.getByRole('button', { name: /Project docs/ }).click();
    await originalPicker.getByRole('button', { name: 'Check tools' }).click();
    await originalPicker.getByRole('checkbox', { name: 'echo', exact: true }).check();
    await originalPicker.getByRole('link', { name: 'Manage connections' }).click();
    await expect(page).toHaveURL(new RegExp(`settingsProject=${projectId}`));
    await page
      .locator('[data-settings-dialog]')
      .getByRole('button', { name: 'Close settings' })
      .click();
    await expect(originalPicker).toBeVisible();
    await expect(
      originalPicker.getByRole('button', { name: 'Apply to the agent original' }),
    ).toBeEnabled();
    await originalPicker.getByRole('button', { name: 'Apply to the agent original' }).click();
    await expect(original.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
      'Private investigator',
    );
    await expect(original.getByRole('textbox', { name: 'Base instructions' })).toHaveValue(
      'Investigate issues.',
    );
    await expect(original.getByText('Project docs · echo', { exact: true })).toBeVisible();
    await expect(
      original.getByText('This tool needs an execution policy that permits MCP.'),
    ).toBeVisible();
    await original.getByRole('button', { name: 'Choose an execution policy' }).click();
    await expect(original.getByRole('combobox', { name: /Harness/ })).toBeFocused();
    await original.getByRole('button', { name: 'Save agent' }).click();
    await expect(original).not.toBeVisible();

    const selected = 'mcp__docs__echo';
    await api('/harness/profiles/investigation', 'PUT', {
      expectedRevision: 0,
      profile: {
        name: 'Investigation',
        policy: 'trusted-native',
        resources: [],
        allowedTools: ['write_artifact', 'submit_result', selected, 'mcp__docs__edit'],
        mcpServerIds: servers.map(({ id }) => id),
        startupCommands: [],
      },
    });
    const definition = linearCorral(['researcher']);
    definition.roles[0]!.harness = { profileId: 'investigation', revision: 1 };
    definition.roles[0]!.modelProfile = 'model-b';
    const { record } = await api('/corrals', 'POST', { definition, projectId });
    const { corralId } = record;
    await page.goto(`${url}/corrals/${corralId}/edit`);
    await openFlowGraph(page);
    await teamNode(page, 'researcher').click();
    const settings = editorSettings(page);
    await expect(settings.getByText('External tools', { exact: true })).toBeVisible();
    const picker = page.getByRole('dialog', { name: 'Add tools', exact: true });
    const discover = async () => {
      await settings.getByRole('button', { name: 'Add tools', exact: true }).click();
      await picker.getByRole('button', { name: /Project docs/ }).click();
      await picker.getByRole('button', { name: 'Check tools', exact: true }).click();
    };
    const echo = picker.getByRole('checkbox', { name: 'echo', exact: true });
    const edit = picker.getByRole('checkbox', { name: 'edit', exact: true });
    const apply = picker.getByRole('button', { name: 'Apply to researcher', exact: true });
    await discover();
    await echo.check();
    await edit.check();
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(picker).toBeHidden();
    await expectTeamSaved(page, 1);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

    await discover();
    await expect(echo).not.toBeChecked();
    await expect(edit).not.toBeChecked();
    await expect(apply).toBeDisabled();
    await echo.check();
    await apply.click();
    await expect(picker).toBeHidden();
    await expect(settings.getByText('Mock tests do not call external tools.')).toBeVisible();
    expect(fixture.mcpCalls).toBe(0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectTeamSaved(page, 2);
    const saved = await api(`/corrals/${corralId}`);
    expect(saved.definition.roles[0].mcpTools).toEqual([{ serverId: 'docs', name: selected }]);

    corral.fake!.answerWith('Found in the project docs.', {
      mcpCall: { name: selected, args: {} },
    });
    const { session } = await api('/sessions', 'POST', { projectId, corralId, title: 'Read docs' });
    await api(`/sessions/${session.sessionId}/worktree`, 'POST', {});
    const { runId } = await api('/runs', 'POST', {
      schemaVersion: '0.1',
      commandId: 'use-seat-mcp',
      sessionId: session.sessionId,
      corralId,
      definitionRevision: 2,
      mode: 'live',
    });
    await page.goto(`${url}/runs/${runId}?view=run`);
    await expect(lastRunSucceeded(page)).toBeVisible();
    expect(fixture.mcpCalls).toBe(1);
    await maximizePanel(page);
    await page.getByRole('button', { name: 'Run info', exact: true }).click();
    const connections = page.getByTestId('status-connections');
    await connections.getByRole('button', { name: /^Connections/ }).click();
    const applied = connections.getByTestId('harness-details');
    await applied.getByText('Applied Harnesses', { exact: true }).click();
    const role = applied.locator('section').filter({
      has: page.getByRole('heading', { name: 'researcher · investigation · r1', exact: true }),
    });
    const allowed = role.getByText(/^Allowed tool names:/);
    await expect(allowed).toBeVisible();
    expect((await allowed.innerText()).match(/mcp__\w+/g)).toEqual([selected]);
    await expect(role.getByText('MCP connections: docs', { exact: true })).toBeVisible();
    expect(corral.errors).toEqual([]);
  } finally {
    await fixture.close();
    rmSync(source, { recursive: true, force: true });
  }
});
