import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import type { AgentAdapter, CorralDefinition } from '@corral/contracts';
import { Gate, linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

// The server's advisor wiring (docs/specs/features/advisor.md): the Coordinator learns a run's
// work folder from the file service, and advice an ended target never read reaches the inbox.

vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function advised(): CorralDefinition {
  const definition = linearCorral(['writer']);
  definition.roles.push({
    id: 'advisor_role',
    name: 'Reviewer of claims',
    prompt: 'Watch the writer.',
    modelProfile: 'model-a',
    allowedWorkTools: [],
    allowedCollaborationTools: [],
    outputContract: 'notes',
  });
  definition.nodes.push({
    id: 'advisor',
    type: 'agent',
    label: 'advisor',
    roleId: 'advisor_role',
    invocation: 'observer',
    outputName: 'notes',
    review: { interval: 3, maxRequestsPerReview: 8 },
  } as CorralDefinition['nodes'][number]);
  definition.capabilityLinks.push({
    id: 'watch_writer',
    kind: 'advise',
    sourceNodeId: 'advisor',
    targetNodeId: 'writer',
  });
  return definition;
}

it('a run names its linked folder to its reviews, and kept advice reaches the inbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-advisor-wiring-'));
  const folder = join(root, 'project');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'one\n');
  const token = 'advisor-wiring-fixture-0123456789abcdef';
  const reviewing = new Gate();
  const release = new Gate();
  // The writer ends first, so its one review is the last one and its concern is kept.
  const advisor = new ScriptedAgentAdapter({
    turns: 1,
    beforeReply: async () => {
      reviewing.open();
      await release.wait();
    },
    advise: () => [{ severity: 'concern', note: 'The figure has no source.\nCheck page 4.' }],
  });
  const writer = new ScriptedAgentAdapter({ turns: 1 });
  const agents: AgentAdapter = {
    start: (input, host) =>
      (input.assignment.kind === 'advisor' ? advisor : writer).start(input, host),
  };
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    bootstrapToken: token,
    agents,
    port: 0,
  });
  cleanups.push(async () => {
    release.open();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', server.url);
    headers.set('cookie', cookie);
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    return fetch(url, { ...init, headers });
  };
  const options = { baseUrl: server.url, fetch: call };
  const workspaces = new WorkspacesApi(options);
  await workspaces.bind('default', folder);
  await workspaces.configure('default', { trusted: true });
  const created = await new RestCorralRepository(options).createSession({
    projectId: 'default',
    title: 'Claims',
  });
  if (!created.ok) throw new Error('no session');
  const sessionId = created.session.sessionId;
  const started = server.coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_start',
    mode: 'mock',
    sessionId,
    definition: advised(),
  });
  const runId = started.runId ?? '';
  await reviewing.wait();
  // While the run works in the linked folder, that folder is the run's work folder.
  const roots = (
    server.coordinator as unknown as { workspaceRoots?: (id: string) => readonly string[] }
  ).workspaceRoots?.(runId);
  expect(roots?.map((path) => path.replace(/\/$/, ''))).toContain(folder);
  release.open();
  await vi.waitFor(() =>
    expect(server.coordinator.getSnapshot(runId).projection.status).toBe('succeeded'),
  );
  const inbox = (await (await call(`${server.url}/api/v1/projects/default/inbox`)).json()) as {
    kind: string;
  }[];
  expect(inbox.filter((item) => item.kind === 'advice')).toEqual([
    {
      kind: 'advice',
      sessionId,
      sessionTitle: 'Claims',
      runId,
      executionId: Object.values(server.coordinator.getSnapshot(runId).projection.executions).find(
        (e) => e.nodeId === 'writer',
      )?.executionId,
      severity: 'concern',
      detail: 'The figure has no source.',
    },
  ]);
});
