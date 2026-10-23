import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

test.use({ live: true, compatibleEndpoint: true });

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('[TC-ABS-011-H] reviewed Markdown agent import survives save/reload and is one undoable edit', async ({
  page,
  corral,
}, testInfo) => {
  test.setTimeout(60000);
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await page.getByRole('switch', { name: /Can change files/ }).check();
  await page.getByRole('button', { name: 'Add Output', exact: true }).click();
  await page
    .locator('.react-flow__node[data-id="agent_1"] .react-flow__handle[data-handleid="out"]')
    .dragTo(
      page.locator('.react-flow__node[data-id="output_1"] .react-flow__handle[data-handleid="in"]'),
    );
  await page.getByRole('button', { name: 'Import Markdown agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import a callable agent' });
  await dialog.getByLabel('Markdown source', { exact: true }).fill(`---
name: explorer
description: Inspect source and report paths
tools: [Read, Glob, ask_user, update_plan]
model: original/provider
---
Read the supplied code and report the evidence.`);
  await choose(page, 'Parent agent', 'Agent 1');
  await choose(page, 'Connected model profile', 'Local server · llama3.2');
  await choose(page, 'Read mapping', 'read_file');
  await choose(page, 'Glob mapping', 'list_files');
  await expect(dialog.getByText('Excluded: handled by parent', { exact: true })).toHaveCount(2);
  const add = dialog.getByRole('button', { name: 'Add to team', exact: true });
  await expect(add).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await page.screenshot({ path: testInfo.outputPath('markdown-import-preview.png') });
  await add.click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'explorer' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'explorer' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'explorer' })).toHaveCount(1);
  const path = new URL(page.url()).pathname
    .replace('/edit', '')
    .replace('/corrals/', '/api/v1/corrals/');
  const saved = await page.evaluate(async (path) => (await fetch(path)).json(), path);
  const child = saved.definition.nodes.find((node: { label: string }) => node.label === 'explorer');
  expect(child.invocation).toBe('callable');
  const role = saved.definition.roles.find((role: { id: string }) => role.id === child.roleId);
  expect(role.allowedCollaborationTools).toEqual(['submit_result', 'ask']);
  expect(role.allowedWorkTools).toEqual(['write_artifact', 'read_file', 'list_files']);
  expect(role.modelProfile).toBe('model-a');
  expect(saved.definition.capabilityLinks).toContainEqual(
    expect.objectContaining({
      kind: 'delegate',
      sourceNodeId: 'agent_1',
      targetNodeId: child.id,
      parentQuestions: true,
    }),
  );
  await page.getByRole('button', { name: 'Import Markdown agent', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Import Markdown agent', exact: true }),
  ).toBeFocused();
  // Existing generic simulated agent follows the imported graph through Coordinator tools.
  // This verifies delegation/result orchestration, not a real model's decision quality.
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agents', exact: true }).selectOption('mock');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText('Succeeded', { timeout: 20000 });
  const run = corral.server.coordinator.listRuns()[0];
  expect(run).toBeDefined();
  if (!run) throw new Error('No run was started');
  const projection = corral.server.coordinator.getSnapshot(run.runId).projection;
  const delegated = Object.values(projection.tasks).filter((task) => task.nodeId === child.id);
  expect(delegated).toHaveLength(2);
  for (const task of delegated) expect(task.submittedArtifactVersionIds.length).toBeGreaterThan(0);
  // Repeat through the normal Run button and real Pi worker with a deterministic local
  // compatible endpoint. The model fixture responds only to the actual request/tool data.
  if (!corral.endpoint) throw new Error('No local model endpoint');
  let parentAnswerCount = 0;
  corral.endpoint.setReply((request) => {
    const body = request as {
      tools?: { function?: { name?: string } }[];
      messages: {
        role: string;
        content?: string;
        tool_call_id?: string;
        tool_calls?: { id: string; function: { name: string } }[];
      }[];
    };
    const isParent = body.tools?.some((tool) => tool.function?.name === 'spawn_subagents');
    const calls = new Map(
      body.messages.flatMap((message) =>
        (message.tool_calls ?? []).map((tool) => [tool.id, tool.function.name] as const),
      ),
    );
    const results = (name: string) =>
      body.messages
        .filter(
          (message) => message.role === 'tool' && calls.get(message.tool_call_id ?? '') === name,
        )
        .map((message) => JSON.parse(message.content ?? '{}') as Record<string, unknown>);
    const call = (name: string, args: unknown) => ({ toolCall: { name, args } });
    if (isParent) {
      const spawned = results('spawn_subagents').at(-1);
      if (!spawned)
        return call('spawn_subagents', {
          tasks: [{ targetNodeId: child.id, brief: 'Ask which scope to inspect, then report it.' }],
        });
      const answered = new Set(results('reply').map((result) => result.questionId));
      const waited = results('await_tasks').at(-1);
      const questions = (waited?.parentQuestions ?? []) as { questionId: string }[];
      const pending = questions.find((question) => !answered.has(question.questionId));
      if (pending) {
        parentAnswerCount += 1;
        return call('reply', {
          questionId: pending.questionId,
          body: 'Inspect only the source folder.',
        });
      }
      const tasks = (waited?.tasks ?? []) as { status: string }[];
      if (!tasks.length || tasks.some((task) => task.status !== 'completed'))
        return call('await_tasks', { taskIds: spawned.taskIds });
    } else if (!results('ask').length) {
      return call('ask', { targetNodeId: 'agent_1', body: 'Which scope should I inspect?' });
    } else {
      expect(results('ask').at(-1)).toMatchObject({
        outcome: 'answered',
        body: 'Inspect only the source folder.',
      });
    }
    const written = results('write_artifact').at(-1);
    if (!written)
      return call('write_artifact', {
        text: isParent ? 'The child continued after my answer.' : 'Inspected the source folder.',
      });
    return call('submit_result', { artifactVersionIds: [written.artifactVersionId] });
  });
  await page.getByRole('combobox', { name: 'Agents', exact: true }).selectOption('live');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns().length, { timeout: 20000 }).toBe(2);
  const liveRun = corral.server.coordinator.listRuns().find((item) => item.runId !== run.runId);
  if (!liveRun) throw new Error('Live run was not created');
  await expect
    .poll(() => corral.server.coordinator.getSnapshot(liveRun.runId).projection.status, {
      timeout: 30000,
    })
    .toBe('succeeded');
  const liveProjection = corral.server.coordinator.getSnapshot(liveRun.runId).projection;
  expect(Object.values(liveProjection.executions)).toHaveLength(2);
  expect(Object.values(liveProjection.questions)).toEqual([
    expect.objectContaining({
      delivery: 'parent',
      status: 'answered',
      targetNodeId: 'agent_1',
      body: 'Which scope should I inspect?',
      answer: expect.objectContaining({ body: 'Inspect only the source folder.' }),
    }),
  ]);
  expect(parentAnswerCount).toBe(1);
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  await page.screenshot({ path: testInfo.outputPath('markdown-parent-question-run.png') });
  expect(corral.errors).toEqual([]);
});

test('[TC-ABS-011-H] Markdown Edit imports a reviewed Hashline role with parent file permissions', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await page.getByRole('switch', { name: /Can change files/ }).check();
  await page.getByRole('button', { name: 'Import Markdown agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import a callable agent' });
  await dialog.getByLabel('Markdown source', { exact: true }).fill(`---
name: fixer
description: Make scoped code changes after reading current files
tools: [Read, Edit]
---
Read the current file before applying a bounded edit.`);
  await choose(page, 'Parent agent', 'Agent 1');
  await choose(page, 'Connected model profile', 'Local server · llama3.2');
  await choose(page, 'Read mapping', 'read_file');
  await choose(page, 'Edit mapping', 'write_file + Hashline editing');
  await expect(dialog.getByText(/Edit selects Hashline mode/)).toBeVisible();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Add to team', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  const path = new URL(page.url()).pathname
    .replace('/edit', '')
    .replace('/corrals/', '/api/v1/corrals/');
  const saved = await page.evaluate(async (path) => (await fetch(path)).json(), path);
  const child = saved.definition.nodes.find((node: { label: string }) => node.label === 'fixer');
  const role = saved.definition.roles.find((role: { id: string }) => role.id === child.roleId);
  expect(role.editingMode).toBe('hashline');
  expect(role.allowedWorkTools).toEqual(['write_artifact', 'read_file', 'write_file']);
  expect(role.allowedCollaborationTools).toEqual(['submit_result', 'ask']);
  expect(role.prompt).toContain('read_hashline, then edit_hashline');
  expect(corral.errors).toEqual([]);
});

test('[TC-ABS-011-H] Bash import inherits a verified local parent work style without trusting source metadata', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  // Pre-existing local configuration, created through its normal owner API. No process runs.
  await page.evaluate(async () => {
    const { csrfToken } = await fetch('/api/v1/session').then((response) => response.json());
    const response = await fetch('/api/v1/harness/profiles/local-shell-style', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        expectedRevision: 0,
        profile: {
          name: 'Local shell style',
          policy: 'trusted-native',
          resources: [],
          startupCommands: [],
          allowedTools: [
            'write_artifact',
            'submit_result',
            'run_command',
            'spawn_subagents',
            'await_tasks',
            'ask',
            'reply',
          ],
        },
      }),
    });
    if (!response.ok) throw new Error(`Local work style setup failed: ${response.status}`);
  });
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await page.getByRole('switch', { name: /Run shell commands/ }).check();
  await page.getByRole('combobox', { name: 'Work styles', exact: true }).click();
  await page.getByRole('option', { name: 'Local shell style · r1', exact: true }).click();
  await page.getByRole('button', { name: 'Import Markdown agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import a callable agent' });
  await dialog.getByLabel('Markdown source', { exact: true }).fill(`---
name: test-runner
description: Run the requested check and report the result
tools: [Bash]
---
Use only the command requested by the parent.`);
  await choose(page, 'Parent agent', 'Agent 1');
  await choose(page, 'Connected model profile', 'Local server · llama3.2');
  await choose(page, 'Bash mapping', 'run_command');
  await expect(
    dialog.getByText(/Inherited work style: local-shell-style · r1 · trusted-native/),
  ).toBeVisible();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Add to team', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  const path = new URL(page.url()).pathname
    .replace('/edit', '')
    .replace('/corrals/', '/api/v1/corrals/');
  const saved = await page.evaluate(async (path) => (await fetch(path)).json(), path);
  const child = saved.definition.nodes.find(
    (node: { label: string }) => node.label === 'test-runner',
  );
  const role = saved.definition.roles.find((role: { id: string }) => role.id === child.roleId);
  expect(role.harness).toEqual({ profileId: 'local-shell-style', revision: 1 });
  expect(role.allowedWorkTools).toEqual(['write_artifact', 'run_command']);
  expect(role.allowedCollaborationTools).toEqual(['submit_result', 'ask']);
  expect(corral.errors).toEqual([]);
});
