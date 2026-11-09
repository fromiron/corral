import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CorralDefinition } from '@corral/contracts';
import type { Coordinator } from '@corral/core';
import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

// The team graph's runtime paths a person meets on screen, on the local server with simulated
// agents (docs/specs/features/team-graph.md): parallel branches and a Join, a router that asks
// the person, a check Decision on a real working copy, and a Loop that stops changing.

async function call(page: Page, path: string, body?: unknown, method = 'POST') {
  return page.evaluate(
    async ({ path, body, method }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
      return json;
    },
    { path, body, method },
  );
}

const role = (id: string) => ({
  id,
  name: id.replace(/_role$/, ''),
  prompt: `Act as ${id.replace(/_role$/, '')}.`,
  modelProfile: 'model-a',
  allowedWorkTools: ['write_artifact'],
  allowedCollaborationTools: ['submit_result'],
  outputContract: 'text' as const,
});
const agent = (id: string, label: string, from: string | null, parentId?: string) => ({
  id,
  type: 'agent' as const,
  label,
  roleId: `${id}_role`,
  invocation: 'scheduled' as const,
  inputBindings: from
    ? [{ kind: 'task_output' as const, name: 'previous', sourceNodeId: from }]
    : [{ kind: 'run_input' as const, name: 'brief' }],
  outputName: 'text',
  ...(parentId ? { parentId } : {}),
});
const edge = (source: string, sourcePort: string, target: string, targetPort = 'in') => ({
  id: `${source}_${sourcePort}_${target}_${targetPort}`,
  source,
  sourcePort,
  target,
  targetPort,
});
const limits = {
  maxDelegationDepth: 2,
  maxModelConcurrency: 6,
  maxSpawns: 12,
  maxQuestions: 6,
  questionTimeoutMs: 120_000,
};

/** The branch choices a decision step made, as the server recorded them. */
function branchesOf(coordinator: Pick<Coordinator, 'getSnapshot'>, runId: string, nodeId: string) {
  const branches = coordinator.getSnapshot(runId).projection.workflowBranches ?? {};
  return Object.values(branches)
    .filter((branch) => branch.nodeId === nodeId)
    .sort((a, b) => a.runSeq - b.runSeq);
}

/** What the run waits on, opened from the run header once something waits. */
async function needsYou(page: Page) {
  await page.getByRole('button', { name: /^Needs your input · \d+$/ }).click();
  return page.getByTestId('run-needs-you');
}

/**
 * Saves a team, opens a session on it and starts a simulated run there; `workingCopy` first gives
 * the session its working copy of the project folder.
 */
async function startRun(page: Page, definition: CorralDefinition, workingCopy = false) {
  const saved = await call(page, '/corrals', { definition });
  const session = await call(page, '/sessions', {
    projectId: 'default',
    title: definition.name,
    corralId: saved.record.corralId,
  });
  if (workingCopy) await call(page, `/sessions/${session.session.sessionId}/worktree`, {});
  const started = await call(page, '/runs', {
    schemaVersion: '0.1',
    commandId: `start_${definition.id}`,
    corralId: saved.record.corralId,
    definitionRevision: saved.record.definitionRevision,
    sessionId: session.session.sessionId,
    mode: 'mock',
  });
  return started.runId as string;
}

test('parallel branches meet at a Join, and a router that cannot choose asks the person', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const definition = {
    schemaVersion: '0.1',
    id: 'parallel_router',
    name: 'Parallel and router',
    entryNodeId: 'plan',
    input: { brief: 'Compare two options.', criteria: ['Cite sources.'] },
    roles: ['plan_role', 'left_role', 'right_role'].map(role),
    nodes: [
      agent('plan', 'Plan', null),
      agent('left', 'Left', 'plan'),
      agent('right', 'Right', 'plan'),
      { id: 'meet', type: 'join', label: 'Meet', policy: 'all' },
      {
        id: 'pick',
        type: 'decision',
        label: 'Pick',
        mode: 'router',
        routes: [
          { id: 'ship', label: 'Ship it' },
          { id: 'fix', label: 'Fix first' },
        ],
        inputBindings: [{ kind: 'task_output', name: 'draft', sourceNodeId: 'left' }],
      },
      {
        id: 'output',
        type: 'output',
        label: 'Output',
        inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: 'right' }],
        requireApproval: false,
      },
    ],
    controlEdges: [
      edge('plan', 'out', 'left'),
      edge('plan', 'out', 'right'),
      edge('left', 'out', 'meet'),
      edge('right', 'out', 'meet'),
      edge('meet', 'out', 'pick'),
      edge('pick', 'ship', 'output'),
      edge('pick', 'fix', 'output'),
    ],
    capabilityLinks: [],
    limits,
  } as CorralDefinition;
  const runId = await startRun(page, definition);
  await page.goto(`${corral.server.url}/runs/${runId}`);

  // The simulated router's pick is not a route id, so the person chooses among the routes.
  await expect(page.getByTestId('run-status').first()).toContainText('Waiting for you', {
    timeout: 15_000,
  });
  const card = (await needsYou(page))
    .locator('[data-testid^="approval-"]')
    .filter({ hasText: 'Choose a route' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Fix first', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Ship it', exact: true }).click();
  await expect(page.getByTestId('run-status').first()).toContainText('Succeeded');

  const projection = corral.server.coordinator.getSnapshot(runId).projection;
  const ran = Object.values(projection.executions).map((execution) => execution.nodeId);
  expect(ran).toEqual(expect.arrayContaining(['plan', 'left', 'right', 'pick']));
  const [branch] = branchesOf(corral.server.coordinator, runId, 'pick');
  expect(branch).toMatchObject({ mode: 'router', reasonCode: 'human_route' });
  expect(corral.errors).toEqual([]);
});

test('a check Decision runs a registered check in the working copy, and a Loop that stops changing asks', async ({
  page,
  corral,
}) => {
  const source = mkdtempSync(join(tmpdir(), 'corral-check-loop-'));
  try {
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
        { cwd: source },
      );
    git('init', '-q');
    // A check that always fails: each round goes back, with the same draft as before.
    writeFileSync(join(source, 'check.mjs'), "console.log('Types failed'); process.exit(1);");
    git('add', '.');
    git('commit', '-qm', 'fixture');
    await corral.open('/');
    await call(page, '/projects/default/workspace', { path: source }, 'PUT');
    await call(page, '/projects/default/workspace', { trusted: true }, 'PATCH');
    await call(
      page,
      '/harness/projects/default/tools',
      {
        expectedRevision: 0,
        config: {
          checks: [{ id: 'types', name: 'Types', argv: ['node', 'check.mjs'], timeoutMs: 10_000 }],
          lspServers: [],
        },
      },
      'PUT',
    );
    const definition = {
      schemaVersion: '0.1',
      id: 'checked_loop',
      name: 'Checked loop',
      entryNodeId: 'rounds',
      input: { brief: 'Write the change.', criteria: ['Types pass.'] },
      roles: [role('writer_role')],
      nodes: [
        { id: 'rounds', type: 'loop', label: 'Rounds', maxIterations: 3, stallDetection: true },
        agent('writer', 'Writer', null, 'rounds'),
        {
          id: 'types',
          type: 'decision',
          label: 'Types',
          mode: 'check',
          checkIds: ['types'],
          parentId: 'rounds',
          inputBindings: [{ kind: 'task_output', name: 'change', sourceNodeId: 'writer' }],
        },
        {
          id: 'output',
          type: 'output',
          label: 'Output',
          inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: 'writer' }],
          requireApproval: false,
        },
      ],
      controlEdges: [
        edge('rounds', 'body', 'writer'),
        edge('writer', 'out', 'types'),
        edge('types', 'pass', 'rounds', 'exit'),
        edge('types', 'fail', 'rounds', 'repeat'),
        edge('rounds', 'next', 'output'),
      ],
      capabilityLinks: [],
      limits,
    } as CorralDefinition;
    const runId = await startRun(page, definition, true);
    await page.goto(`${corral.server.url}/runs/${runId}`);

    // A check command not run before needs the person's approval; the Loop then stops changing.
    const waiting = page.getByTestId('run-needs-you');
    const stalled = waiting
      .locator('[data-testid^="approval-"]')
      .filter({ hasText: 'Loop stopped changing' });
    const check = waiting.getByRole('button', { name: 'Run this check once', exact: true });
    for (let step = 0; step < 4 && !(await stalled.isVisible()); step++) {
      await expect(page.getByTestId('run-status').first()).toContainText('Waiting for you', {
        timeout: 15_000,
      });
      await needsYou(page);
      await expect(check.or(stalled).first()).toBeVisible();
      if (await check.isVisible()) {
        await check.first().click();
        await expect(page.getByTestId('run-status').first()).not.toContainText('Waiting for you');
      }
    }
    await expect(stalled).toBeVisible();
    await expect(stalled).toContainText('This round submitted the same work as the round before.');
    await stalled.getByRole('button', { name: 'Stop here', exact: true }).click();
    await expect(page.getByTestId('run-status').first()).toContainText('Cancelled');

    const verdicts = branchesOf(corral.server.coordinator, runId, 'types');
    expect(verdicts.length).toBe(2);
    for (const verdict of verdicts)
      expect(verdict).toMatchObject({ mode: 'check', reasonCode: 'check_verdict' });
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
