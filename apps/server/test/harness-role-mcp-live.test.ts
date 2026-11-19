import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '@corral/contracts';
import { InProcessTransport, waitForProjection } from '@corral/core';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { afterEach, expect, it } from 'vitest';
import { startCorralServer } from '../src/app.ts';
import {
  FAKE_PROFILES,
  type FauxResponseStep,
  fakeOpenAI,
  fauxAssistantMessage,
  fauxToolCall,
} from '../src/testing.ts';
import { oauthFixture } from './fixtures/mcp-oauth.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(roles: string[] = ['researcher']) {
  const root = mkdtempSync(join(tmpdir(), 'corral-role-mcp-live-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
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
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.corral'), { recursive: true });
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({
      schemaVersion: '0.1',
      modelProfiles: FAKE_PROFILES,
    }),
  );
  const fixture = await oauthFixture();
  cleanup.push(fixture.close);
  const token = 'role-mcp-live-bootstrap-0123456789abcdef';
  const fake = fakeOpenAI({ configDir: join(root, 'config'), codexLogin: {} });
  const server = await startCorralServer({
    workspace,
    worktreeRoot: join(root, 'worktrees'),
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    live: fake.live,
  });
  cleanup.push(() => server.close());
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token }),
  });
  const headers = {
    'content-type': 'application/json',
    origin: server.url,
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
  };
  const call = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      headers,
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(data)}`).toBe(true);
    return data;
  };
  await call('/projects/default/workspace', { path: source }, 'PUT');
  await call('/projects/default/workspace', { trusted: true }, 'PATCH');
  const config = await call('/harness/projects/default/mcp', {
    expectedRevision: 0,
    operationId: 'add-docs',
    draft: {
      enabled: true,
      name: 'Docs',
      transport: 'http',
      url: fixture.url,
      exposure: 'direct',
      timeoutMs: 5000,
      auth: { kind: 'bearer' },
    },
  });
  const serverId: string = config.mcpServers[0].id;
  const path = `/harness/projects/default/mcp-servers/${serverId}`;
  const { fingerprint } = await call(`${path}/launch`);
  await call(`${path}/trust`, { fingerprint, trusted: true }, 'PUT');
  await call(`${path}/auth`, { action: 'bearer', fingerprint, token: 'fixture-access-0' });
  const probeTools = async (operationId: string) => {
    const result = await call(`${path}/probe`, { operationId, configRevision: 1, fingerprint });
    return result.tools.map((tool: { name: string }) => tool.name).sort();
  };
  const echo = `mcp__${serverId}__echo`,
    edit = `mcp__${serverId}__edit`,
    archive = `mcp__${serverId}__archive`;
  await call(
    '/harness/profiles/docs',
    {
      expectedRevision: 0,
      profile: {
        name: 'Docs',
        policy: 'trusted-native',
        resources: [],
        startupCommands: [],
        // Include the future name: it must be the role, not the profile, that excludes it.
        allowedTools: ['write_artifact', 'submit_result', echo, edit, archive],
        mcpServerIds: [serverId],
      },
    },
    'PUT',
  );
  const definition = linearCorral(roles);
  for (const role of definition.roles) role.modelProfile = 'model-b';
  definition.roles[0]!.harness = { profileId: 'docs', revision: 1 };
  definition.roles[0]!.mcpTools = [{ serverId, name: echo }];
  const saved = await call('/corrals', { definition });
  const {
    session: { sessionId },
  } = await call('/sessions', { projectId: 'default', title: 'Role tools' });
  await call(`/sessions/${sessionId}/worktree`, {});
  const transport = new InProcessTransport(server.coordinator);
  const start = async (commandId: string) => {
    const { runId } = await call('/runs', {
      schemaVersion: '0.1',
      commandId,
      corralId: saved.record.corralId,
      definitionRevision: 1,
      sessionId,
      mode: 'live',
    });
    const events: RunEvent[] = [];
    cleanup.push(transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) }));
    const settled = () =>
      waitForProjection(
        transport,
        runId,
        (p) =>
          ['succeeded', 'failed', 'cancelled'].includes(p.status) ||
          Object.values(p.approvals).some((a) => a.status === 'pending'),
      );
    return { runId: runId as string, events, settled };
  };
  return { start, fixture, transport, fake, echo, edit, archive, probeTools };
}

function lifecycle(events: RunEvent[], name: string) {
  const request = events.find(
    (event) => event.type === 'tool.requested' && event.payload.name === name,
  );
  if (request?.type !== 'tool.requested') return [];
  return events.filter(
    (event) =>
      'toolCallId' in event.payload &&
      event.payload.toolCallId === request.payload.toolCallId &&
      event.type.startsWith('tool.'),
  );
}

it.each(['edit', 'archive'] as const)(
  'executes the selected echo but blocks %s when the same team runs again',
  async (unpicked) => {
    const s = await setup();
    expect(await s.probeTools('initial')).toEqual([s.echo, s.edit]);
    expect(s.fixture.mcpCalls).toBe(0);
    s.fake.answerWith('Read docs.', { mcpCall: { name: s.echo, args: {} } });
    const selected = await s.start('selected');
    expect((await selected.settled()).status).toBe('succeeded');
    expect(lifecycle(selected.events, s.echo).map((event) => event.type)).toEqual([
      'tool.requested',
      'tool.allowed',
      'tool.started',
      'tool.finished',
    ]);
    expect(s.fixture.mcpCalls).toBe(1);

    if (unpicked === 'archive') {
      s.fixture.enableExtraTool(true);
      expect(await s.probeTools('after-add')).toEqual([s.archive, s.echo, s.edit]);
    }
    s.fake.answerWith('No such tool available.', { mcpCall: { name: s[unpicked], args: {} } });
    const run = await s.start('unpicked');
    const final = await run.settled();
    expect(lifecycle(run.events, s[unpicked]).map((event) => event.type)).toEqual([
      'tool.requested',
      'tool.blocked',
    ]);
    expect(s.fixture.mcpCalls).toBe(1);
    expect(final.status).toBe('succeeded');
    const registered = run.events.findLast(
      (event) => event.type === 'harness.loaded' || event.type === 'harness.tools_updated',
    );
    expect(
      registered?.payload.tools
        .filter((tool) => tool.name.startsWith('mcp__'))
        .map((tool) => tool.name),
    ).toEqual([s.echo]);
  },
);

it('offers echo to the researcher but not the unbound writer in the same live run', async () => {
  const s = await setup(['researcher', 'writer']);
  const offered: string[][] = [];
  const attempt: FauxResponseStep = (context) => {
    offered.push(
      getCurrentTools(context.messages)
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('mcp__')),
    );
    return fauxAssistantMessage([fauxToolCall(s.echo, {})], { stopReason: 'toolUse' });
  };
  const submit: FauxResponseStep = (context) => {
    const result = context.messages.findLast(
      (m) => m.role === 'toolResult' && m.toolName === 'write_artifact',
    );
    const part =
      result?.role === 'toolResult' && !result.isError
        ? result.content.find((p) => p.type === 'text')
        : null;
    if (!part) throw new Error('Missing artifact for role handoff');
    return fauxAssistantMessage(
      [
        fauxToolCall('submit_result', {
          artifactVersionIds: [JSON.parse(part.text).artifactVersionId],
        }),
      ],
      { stopReason: 'toolUse' },
    );
  };
  s.fake.setResponses([
    ...['Research notes.', 'Writer reply.'].flatMap((text) => [
      attempt,
      fauxAssistantMessage([fauxToolCall('write_artifact', { text })], { stopReason: 'toolUse' }),
      submit,
    ]),
    fauxAssistantMessage('Done.'),
  ]);
  const run = await s.start('two-roles');
  const final = await run.settled();
  expect(final.status).toBe('succeeded');
  expect(offered).toEqual([[s.echo], []]);
  expect(s.fixture.mcpCalls).toBe(1);
});

it('records cancellation of the in-flight echo and discards its late reply', async () => {
  const s = await setup();
  const hold = s.fixture.holdNextCall();
  try {
    s.fake.answerWith('Must not publish.', { mcpCall: { name: s.echo, args: {} } });
    const run = await s.start('will-cancel');
    await expect.poll(() => s.fixture.mcpCalls).toBe(1);
    const started = lifecycle(run.events, s.echo).find((e) => e.type === 'tool.started');
    if (!started) throw new Error('In-flight echo must have a recorded tool.started');
    const cancelled = await s.transport.sendCommand({
      schemaVersion: '0.1',
      runId: run.runId,
      commandId: 'stop-echo',
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'Stop the pending docs request.' },
    });
    expect(cancelled.status).toBe('accepted');
    expect((await run.settled()).status).toBe('cancelled');
    const requests = s.fake.seen.tokens.length;
    hold.release.open();
    await hold.replied.wait();
    const { projection } = await s.transport.getSnapshot(run.runId);
    expect(
      run.events.filter(
        (e) => e.type === 'effect.settled' && e.payload.effectId === started.payload.effectId,
      ),
    ).toMatchObject([{ payload: { outcome: 'cancelled' } }]);
    expect(
      lifecycle(run.events, s.echo).some((e) => e.type === 'tool.finished' && !e.payload.error),
    ).toBe(false);
    expect(projection.status).toBe('cancelled');
    expect(projection.artifacts).toEqual({});
    expect(s.fake.seen.tokens).toHaveLength(requests);
  } finally {
    hold.release.open();
  }
});
