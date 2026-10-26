import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { HarnessProfileRevision } from '@corral/contracts';
import { type CorralServer, startCorralServer } from '@corral/server';
import { fakeOpenAI } from '@corral/server/testing';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { type CompatibleEndpoint, startCompatibleEndpoint } from '@corral/testkit/endpoint';
import { test as base, expect, type Page } from '@playwright/test';
import {
  PiAgentAdapter,
  processChannel,
  SDK_WORKER_ENTRY,
  sdkProcessChannel,
  WORKER_ENTRY,
} from '../../../../packages/adapter-pi/src/index.ts';
import { panelTab, requestBox, selectSessionTeam } from '../workbench.ts';

// Only the remote model response is deterministic. Both Pi worker processes, every
// Coordinator approval, the native command job and managed file broker are production.
interface CapabilityFixture {
  server: CorralServer;
  endpoint: CompatibleEndpoint;
  root: string;
  source: string;
  workspace: string;
  worktrees: string;
  errors: string[];
  open(path?: string): Promise<void>;
}

const test = base.extend<{ capability: CapabilityFixture }>({
  capability: async ({ page }, use) => {
    page.setDefaultTimeout(15000);
    const root = mkdtempSync(join(tmpdir(), 'corral-capability-ui-'));
    const workspace = join(root, 'workspace');
    const source = join(root, 'source');
    const worktrees = join(root, 'worktrees');
    const configDir = join(root, 'credentials');
    mkdirSync(join(workspace, '.corral'), { recursive: true });
    mkdirSync(source);
    const endpoint = await startCompatibleEndpoint();
    const registry = fakeOpenAI({ configDir });
    writeFileSync(
      join(workspace, '.corral', 'config.json'),
      JSON.stringify({
        schemaVersion: '0.1',
        modelProviders: [
          {
            id: 'local-fixture',
            name: 'Local integration endpoint',
            baseUrl: endpoint.baseUrl,
            access: 'none',
            models: [{ id: 'fixture-model', contextWindow: 32000, maxOutput: 2048 }],
          },
        ],
        modelProfiles: [
          {
            id: 'model-a',
            provider: 'local-fixture',
            model: 'fixture-model',
            compaction: { reserveTokens: 4000, keepRecentTokens: 8000 },
          },
        ],
      }),
    );
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
        { cwd: source, stdio: 'pipe' },
      );
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(source, 'README.md'), 'original note\n');
    writeFileSync(
      join(source, 'command-write.mjs'),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('command.txt', 'created by run_command\\n');\nconsole.log('command file written');\n",
    );
    writeFileSync(
      join(source, 'long-job.mjs'),
      [
        "import { appendFileSync } from 'node:fs';",
        "import { spawn } from 'node:child_process';",
        "const depth = Number(process.argv[2] ?? '0');",
        "appendFileSync('children.jsonl', JSON.stringify({ pid: process.pid, depth }) + '\\n');",
        "if (depth < 2) spawn(process.execPath, ['long-job.mjs', String(depth + 1)], { stdio: 'inherit' });",
        'setInterval(() => console.log("owned child " + depth), 100);',
      ].join('\n'),
    );
    git('add', '.');
    git('commit', '-qm', 'integration fixture');
    const external: string[] = [];
    const errors: string[] = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
      external.push(url.origin);
      return route.abort('blockedbyclient');
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const server = await startCorralServer({
      workspace,
      worktreeRoot: worktrees,
      port: 0,
      staticDir: join(import.meta.dirname, '..', '..', 'dist'),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      live: {
        ...registry.live,
        agents: (models, harnesses, leaseDirectory) =>
          new PiAgentAdapter({
            spawn: () => processChannel(WORKER_ENTRY, { leaseDirectory }),
            spawnSdk: () => sdkProcessChannel(SDK_WORKER_ENTRY, { leaseDirectory }),
            harness: (input) => harnesses.runtimeResources(input),
            credentials: (model) => models.credentials(model),
            endpoint: (model) => models.endpointOf(model),
            cancelGraceMs: 9000,
          }),
      },
    });
    try {
      await use({
        server,
        endpoint,
        root,
        source,
        workspace,
        worktrees,
        errors,
        async open(path = '/') {
          await page.goto(`${server.url}${path}#${server.bootstrapUrl.split('#')[1]}`);
          await expect(page.getByRole('banner')).toBeVisible();
        },
      });
    } finally {
      await server.close();
      await endpoint.close();
      // This generated root owns only this test's processes, repository and credentials.
      const cleanupRoot = realpathSync(root);
      if (
        dirname(cleanupRoot) === realpathSync(tmpdir()) &&
        /^corral-capability-ui-[A-Za-z0-9]+$/.test(basename(cleanupRoot))
      )
        await rm(cleanupRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    expect(external).toEqual([]);
  },
});

const tools = [
  'run_command',
  'read_file',
  'write_file',
  'read_hashline',
  'edit_hashline',
  'write_artifact',
  'submit_result',
  'ask_user',
];

async function prepareSession(page: Page, capability: CapabilityFixture) {
  await capability.open('/');
  await page.getByRole('tab', { name: /^Project folder/ }).click();
  const folder = page.getByRole('tabpanel', { name: 'Project folder', exact: true });
  await folder.getByLabel('Folder path on this computer').fill(capability.source);
  await folder.getByRole('button', { name: 'Link folder', exact: true }).click();
  const trust = folder.getByRole('switch', { name: /Trust this repository/ });
  await trust.click();
  await expect(trust).toBeChecked();

  await page.goto(`${capability.server.url}/settings/harness?projectId=default`);
  await page.getByLabel('Work style name', { exact: true }).fill('Native integration work');
  await page.getByRole('combobox', { name: 'Policy', exact: true }).click();
  await page.getByRole('option', { name: 'Trusted native extensions', exact: true }).click();
  await page.getByLabel('Allowed tool names', { exact: true }).fill(tools.join(', '));
  await page.getByRole('button', { name: 'Save work style', exact: true }).click();
  await expect(page.getByTestId('harness-status')).toContainText('Saved revision 1');
  const response = await page.request.get(`${capability.server.url}/api/v1/harness/profiles`);
  expect(response.ok()).toBe(true);
  const profile = ((await response.json()) as HarnessProfileRevision[]).find(
    (item) => item.name === 'Native integration work',
  );
  if (!profile) throw new Error('The work style was not saved through Settings');
  expect(profile.policy).toBe('trusted-native');

  const definition = linearCorral(['writer'], 'native_integration');
  definition.name = 'Native integration team';
  definition.input = {
    brief: 'Change the managed copy.',
    criteria: ['Preserve the source folder.'],
  };
  const role = definition.roles[0];
  if (!role) throw new Error('Missing imported role');
  role.allowedWorkTools = ['read_file', 'write_file', 'run_command', 'write_artifact'];
  role.allowedCollaborationTools = ['submit_result', 'ask_user'];
  role.editingMode = 'hashline';
  role.harness = { profileId: profile.profileId, revision: profile.revision };
  const definitionPath = join(capability.root, 'native-integration.corral.json');
  writeFileSync(definitionPath, JSON.stringify(definition));
  // The signed-in page reuses its session cookie.
  await page.goto(`${capability.server.url}/projects/default`);
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.locator('input[type="file"]').setInputFiles(definitionPath);
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
  await page.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Native integration');
  await page.getByRole('combobox', { name: 'Corral', exact: true }).click();
  await page.getByRole('option', { name: 'Native integration team', exact: true }).click();
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  if (!sessionId) throw new Error('The UI did not create a session');
  await panelTab(page, 'Changes');
  // The working copy offer sits beside the panel's empty state.
  await page.getByRole('button', { name: /Make a working copy from/ }).click();
  await expect(page.getByRole('link', { name: 'Review changes', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Permissions for next request', exact: true }).click();
  await page
    .getByRole('option')
    .filter({ has: page.getByText('Ask', { exact: true }) })
    .click();
  const worktree = readdirSync(capability.worktrees, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(capability.worktrees, entry.name, sessionId))
    .find((path) => existsSync(join(path, '.git')));
  if (!worktree) throw new Error('The UI did not create the managed Git working copy');
  return { sessionId, worktree };
}

async function approval(page: Page, name: string) {
  await expect(page.getByTestId('action-required')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('action-required').getByRole('link').click();
  const card = page
    .getByTestId('run-monitor')
    .locator('[data-testid^="approval-"]')
    .filter({ hasText: `${name} · corral` });
  await expect(card).toBeVisible({ timeout: 30000 });
  return card;
}

function current(capability: CapabilityFixture) {
  const run = capability.server.coordinator.listRuns()[0];
  if (!run) throw new Error('No run was started through the composer');
  return { runId: run.runId, ...capability.server.coordinator.getSnapshot(run.runId) };
}

function lastToolResult(body: unknown): Record<string, unknown> {
  const messages = (body as { messages: { role: string; content: unknown }[] }).messages;
  const content = [...messages].reverse().find((message) => message.role === 'tool')?.content;
  if (typeof content !== 'string') throw new Error('The endpoint did not receive a tool result');
  return JSON.parse(content) as Record<string, unknown>;
}

type Reply = Parameters<CompatibleEndpoint['setReply']>[0];
const offeredTools = (body: unknown) =>
  (body as { tools?: { function?: { name?: string } }[] }).tools?.map(
    (tool) => tool.function?.name,
  ) ?? [];

/**
 * in a Corral session the conversation lead gives the Corral's writer one task, waits
 * for it and answers with its own reply. The writer keeps its pinned work style and Hashline.
 */
function leadThenWriter(writer: Reply, answer: string): Reply {
  return (body) => {
    if (!offeredTools(body).includes('spawn_subagents')) return writer(body);
    const messages = (body as { messages: { role: string; content: unknown }[] }).messages;
    if (!messages.some((message) => message.role === 'tool')) {
      // The only delegate the spawn tool offers is the Corral's writer.
      const spawn = (
        body as { tools: { function: { name: string; parameters: unknown } }[] }
      ).tools.find((tool) => tool.function.name === 'spawn_subagents');
      const target = /"targetNodeId":\{[^}]*?"const":"([^"]+)"/.exec(
        JSON.stringify(spawn?.function.parameters),
      )?.[1];
      if (!target) throw new Error('The lead was offered no delegate');
      return {
        toolCall: {
          name: 'spawn_subagents',
          args: { tasks: [{ targetNodeId: target, brief: 'Do the requested work in the copy.' }] },
        },
      };
    }
    const result = lastToolResult(body);
    if (Array.isArray(result.taskIds) && !Array.isArray(result.tasks))
      return { toolCall: { name: 'await_tasks', args: { taskIds: result.taskIds } } };
    return answer;
  };
}

async function readCommandReport(page: Page, capability: CapabilityFixture, sessionId: string) {
  const baseUrl = `${capability.server.url}/api/v1/sessions/${sessionId}/processes`;
  const commands = await page.request.get(baseUrl);
  expect(commands.ok()).toBe(true);
  const latest = ((await commands.json()) as { id: string }[])[0];
  if (!latest) return null;
  const response = await page.request.get(`${baseUrl}/${latest.id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test('Ask approves a real command and a read-bound Hashline edit in the managed copy', async ({
  page,
  capability,
}) => {
  test.setTimeout(120000);
  let step = 0;
  const answer = 'The managed copy contains both requested changes.';
  const writer: Reply = (body) => {
    step += 1;
    expect(offeredTools(body)).toEqual(
      expect.arrayContaining(['run_command', 'read_hashline', 'edit_hashline']),
    );
    if (step === 1)
      return { toolCall: { name: 'run_command', args: { command: 'node command-write.mjs' } } };
    if (step === 2) {
      expect(lastToolResult(body)).toMatchObject({ state: 'completed', cleanupConfirmed: true });
      return { toolCall: { name: 'read_hashline', args: { path: 'README.md' } } };
    }
    if (step === 3) {
      const read = lastToolResult(body);
      expect(read.text).toContain('1:original note');
      expect(read.tag).toMatch(/^[a-f0-9]{4}$/i);
      return {
        toolCall: {
          name: 'edit_hashline',
          args: {
            version: 1,
            path: 'README.md',
            tag: read.tag,
            ops: 'PUT 1.=1:\n+updated by Hashline',
          },
        },
      };
    }
    return answer;
  };
  capability.endpoint.setReply(leadThenWriter(writer, answer));
  const { sessionId, worktree } = await prepareSession(page, capability);
  await requestBox(page).fill('Run the local writer command, then update the note using Hashline.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const command = await approval(page, 'run_command');
  await expect(command).toContainText('node command-write.mjs');
  expect(existsSync(join(worktree, 'command.txt'))).toBe(false);
  expect(
    capability.server.coordinator.getRunSnapshot(current(capability).runId)?.permissionMode,
  ).toBe('ask');
  await command.getByRole('button', { name: 'Allow once', exact: true }).click();
  const edit = await approval(page, 'edit_hashline');
  await expect(edit).toContainText('updated by Hashline');
  expect(readFileSync(join(worktree, 'command.txt'), 'utf8')).toBe('created by run_command\n');
  expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('original note\n');
  await edit.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect
    .poll(() => current(capability).projection.status, { timeout: 30000 })
    .toBe('succeeded');
  expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('updated by Hashline\n');
  expect(readFileSync(join(capability.source, 'README.md'), 'utf8')).toBe('original note\n');
  expect(existsSync(join(capability.source, 'command.txt'))).toBe(false);
  expect(await readCommandReport(page, capability, sessionId)).toMatchObject({
    state: 'completed',
    exitCode: 0,
    cleanupConfirmed: true,
  });
  await panelTab(page, 'Changes');
  await page.getByRole('link', { name: 'Review changes', exact: true }).click();
  await expect(page).toHaveURL(/\/review/);
  await page.getByRole('button', { name: /command\.txt/ }).click();
  await expect(page.getByTestId('file-diff')).toContainText('created by run_command');
  await page.getByRole('button', { name: /README\.md/ }).click();
  await expect(page.getByTestId('file-diff')).toContainText('updated by Hashline');
  expect(capability.errors).toEqual([]);
});

for (const cancelScope of ['run', 'command'] as const) {
  test(`${cancelScope === 'run' ? 'Cancel whole run' : 'Stop command'} kills the owned child and grandchild before confirming cleanup`, async ({
    page,
    capability,
  }) => {
    test.setTimeout(120000);
    let step = 0;
    const answer = 'The local command and its descendants were stopped by the user.';
    const writer: Reply = (body) => {
      step += 1;
      if (step === 1)
        return {
          toolCall: {
            name: 'run_command',
            args: { command: 'node long-job.mjs', timeoutMs: 60000 },
          },
        };
      expect(lastToolResult(body)).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
      return answer;
    };
    capability.endpoint.setReply(leadThenWriter(writer, answer));
    const { sessionId, worktree } = await prepareSession(page, capability);
    await requestBox(page).fill('Run the long local job so I can cancel its whole process tree.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const command = await approval(page, 'run_command');
    await expect(command).toContainText('node long-job.mjs');
    await command.getByRole('button', { name: 'Allow once', exact: true }).click();
    const children = () =>
      existsSync(join(worktree, 'children.jsonl'))
        ? readFileSync(join(worktree, 'children.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { pid: number; depth: number })
        : [];
    await expect.poll(() => children().length, { timeout: 30000 }).toBe(3);
    const owned = children();
    expect(owned.map((child) => child.depth).sort()).toEqual([0, 1, 2]);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(owned.every((child) => alive(child.pid))).toBe(true);
    if (cancelScope === 'run') {
      await page
        .getByRole('region', { name: 'Request', exact: true })
        .getByRole('button', { name: 'Cancel whole run', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Cancel whole run', exact: true })
        .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
        .click();
    } else {
      await panelTab(page, 'Tasks & preview');
      const commands = page.getByTestId('worktree-command-panel');
      await expect(commands).toContainText('node long-job.mjs');
      await commands.getByRole('button', { name: 'Stop command', exact: true }).click();
    }
    await expect
      .poll(() => owned.some((child) => alive(child.pid)), { timeout: 30000 })
      .toBe(false);
    await expect
      .poll(() => readCommandReport(page, capability, sessionId), { timeout: 30000 })
      .toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    await panelTab(page, 'Tasks & preview');
    const commands = page.getByTestId('worktree-command-panel');
    await expect(commands).toContainText('Stopped');
    await expect(commands).toContainText('Process cleanup confirmed');
    await expect
      .poll(() => current(capability).projection.status, { timeout: 30000 })
      .toBe(cancelScope === 'run' ? 'cancelled' : 'succeeded');
    if (cancelScope === 'run')
      await test.info().attach('confirmed-cancellation-state', {
        body: JSON.stringify(current(capability).projection, null, 2),
        contentType: 'application/json',
      });
    await expect(page.getByTestId('action-required')).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(commands).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    const hidePanel = page.getByRole('banner').getByRole('button', { name: 'Hide the panel' });
    await hidePanel.focus();
    await hidePanel.press('Enter');
    await expect(commands).not.toBeVisible();
    const showPanel = page.getByRole('banner').getByRole('button', { name: 'Show the panel' });
    await expect(showPanel).toBeFocused();
    await showPanel.press('Enter');
    await expect(commands).toBeVisible();
    await commands.getByText('Output', { exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(commands).toContainText('owned child');
    const bounds = await commands.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(existsSync(join(capability.source, 'children.jsonl'))).toBe(false);
    expect(capability.errors).toEqual([]);
  });
}

// the composer no longer starts a review-only reader beside a running writer, so
// ABS-06's same-session reader is not reachable here; the other-session writer still is.
test('a session writer and another session’s writer keep separate controls', async ({
  page,
  capability,
}) => {
  test.setTimeout(180000);
  let commandIssued = false;
  let commandConfirmed = false;
  capability.endpoint.setReply((body) => {
    const offered = offeredTools(body);
    const messages = (body as { messages: { role: string; content: unknown }[] }).messages;
    // Corral's current state follows the request as the last user message, so the
    // request's label is the latest one in any user message.
    const users = JSON.stringify(
      messages.filter((message) => message.role === 'user').map((message) => message.content),
    );
    const label = [...users.matchAll(/Hold ([ABC])/g)].at(-1)?.[1];
    if (!label) throw new Error('The model request is missing its current Hold instruction');
    expect(offered).toContain('ask_user');
    if (label === 'A' && !commandIssued) {
      expect(offered).toContain('run_command');
      commandIssued = true;
      return { toolCall: { name: 'run_command', args: { command: 'node command-write.mjs' } } };
    }
    if (label === 'A' && !commandConfirmed) {
      expect(lastToolResult(body)).toMatchObject({ state: 'completed', cleanupConfirmed: true });
      commandConfirmed = true;
    }
    return {
      toolCall: {
        name: 'ask_user',
        args: {
          key: `hold_${label.toLowerCase()}`,
          questions: [
            {
              id: 'continue',
              kind: 'text',
              prompt: `Fixture ${label} is waiting for your answer.`,
            },
          ],
        },
      },
    };
  });
  const first = await prepareSession(page, capability);
  // Without a team, the lead works in the session default of the trusted folder.
  await selectSessionTeam(page, 'No team');
  await requestBox(page).fill(
    'Hold A: run node command-write.mjs, then wait while I inspect the independent controls.',
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const commandApproval = await approval(page, 'run_command');
  await expect(commandApproval).toContainText('node command-write.mjs');
  expect(existsSync(join(first.worktree, 'command.txt'))).toBe(false);
  await commandApproval.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(page.getByTestId('run-monitor')).toContainText(
    'Fixture A is waiting for your answer.',
    { timeout: 30000 },
  );
  expect(commandConfirmed).toBe(true);
  expect(readFileSync(join(first.worktree, 'command.txt'), 'utf8')).toBe(
    'created by run_command\n',
  );
  expect(existsSync(join(capability.source, 'command.txt'))).toBe(false);
  expect(await readCommandReport(page, capability, first.sessionId)).toMatchObject({
    state: 'completed',
    exitCode: 0,
    cleanupConfirmed: true,
  });
  const findRun = (label: string) =>
    capability.server.coordinator
      .listRuns()
      .find((run) =>
        capability.server.coordinator
          .getRunSnapshot(run.runId)
          ?.definition.input.brief.includes(`Hold ${label}`),
      );
  const status = (label: string) => findRun(label)?.status;
  await expect.poll(() => status('A'), { timeout: 30000 }).toBe('awaiting_user');
  const a = findRun('A')?.runId;
  if (!a) throw new Error('Session writer A did not start');
  expect(capability.server.coordinator.getRunSnapshot(a)?.definition.roles[0]?.harness).toEqual({
    profileId: 'session-default',
    revision: 1,
  });
  expect(
    capability.server.coordinator.getRunSnapshot(a)?.definition.roles[0]?.allowedWorkTools,
  ).toContain('run_command');

  await page.goto(`${capability.server.url}/projects/default`);
  await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
  await page.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Independent writer C');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  await panelTab(page, 'Changes');
  await page.getByRole('button', { name: /Make a working copy from/ }).click();
  await requestBox(page).fill('Hold C in this separate working copy.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => status('C'), { timeout: 30000 }).toBe('awaiting_user');
  const c = findRun('C');
  expect(c?.sessionId).not.toBe(first.sessionId);
  // Cancelling the other session's writer leaves this session's writer waiting.
  await page
    .getByRole('region', { name: 'Request', exact: true })
    .getByRole('button', { name: 'Cancel whole run', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Cancel whole run', exact: true })
    .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
    .click();
  await expect.poll(() => status('C'), { timeout: 30000 }).toBe('cancelled');
  expect(status('A')).toBe('awaiting_user');
  await page.goto(`${capability.server.url}/sessions/${first.sessionId}?run=${a}`);
  await expect(page.getByTestId(`run-card-${a}`).getByTestId('run-required-action')).toBeVisible();
  expect(capability.errors).toEqual([]);
});
