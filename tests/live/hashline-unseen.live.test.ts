import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '@corral/contracts';
import { InProcessTransport, parseWorkspaceConfig, waitForProjection } from '@corral/core';
import { createLiveModels, startCorralServer } from '@corral/server';
import { linearCorral } from '@corral/testkit';
import { expect, it } from 'vitest';
import { RestCorralRepository, WorkspacesApi } from '../../packages/client/src/index.ts';
import { ROOT } from '../../tools/release/candidate.ts';

// Explicit opt-in only (CORRAL_HASHLINE_LIVE=1), watched by the person or agent who starts it.
// desktop-contract.md ABS-03: an edit that names rows the role never saw changes nothing and
// shows those rows; the same tag then edits them. This settles whether a real model follows it.
const profileId = process.env.CORRAL_HASHLINE_PROFILE ?? 'deepseek-hive';
it.skipIf(process.env.CORRAL_HASHLINE_LIVE !== '1')(
  `${profileId}: an edit past a partial Hashline read shows the unseen rows, and the next edit lands`,
  async () => {
    const parsed = parseWorkspaceConfig(
      JSON.parse(readFileSync(join(ROOT, '.corral/config.json'), 'utf8')),
    );
    if (!parsed.ok) throw new Error('invalid workspace config');
    const profile = parsed.config.modelProfiles?.find((row) => row.id === profileId);
    if (!profile) throw new Error(`${profileId} is not configured`);
    const root = mkdtempSync(join(tmpdir(), 'corral-hashline-live-'));
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, '.corral'), { recursive: true });
    writeFileSync(
      join(workspace, '.corral/config.json'),
      JSON.stringify({
        schemaVersion: '0.1',
        modelProfiles: [profile],
        modelProviders: parsed.config.modelProviders?.filter((row) => row.id === profile.provider),
      }),
    );
    const folder = join(root, 'folder');
    mkdirSync(folder);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: folder });
    git('init', '-q');
    writeFileSync(
      join(folder, 'notes.txt'),
      `${Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join('\n')}\n`,
    );
    git('add', '.');
    git('commit', '-qm', 'notes');
    const token = randomUUID();
    const server = await startCorralServer({
      workspace,
      port: 0,
      live: createLiveModels(),
      agents: {
        start: async () => {
          throw new Error('A live check cannot use the mock adapter');
        },
      },
      worktreeRoot: join(root, 'copies'),
      bootstrapToken: token,
    });
    let runId: string | null = null;
    const stop = () => {
      if (runId)
        server.coordinator.submit({
          schemaVersion: '0.1',
          commandId: `stop_${randomUUID()}`,
          runId,
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'hashline live check closed' },
        });
    };
    const deadline = setTimeout(stop, 280000);
    try {
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
      const repository = new RestCorralRepository(options);
      const workspaces = new WorkspacesApi(options);
      await workspaces.bind('default', folder);
      await workspaces.configure('default', { trusted: true });
      const made = await repository.createSession({ projectId: 'default', title: 'Notes' });
      if (!made.ok) throw new Error(made.message);
      const sessionId = made.session.sessionId;
      await workspaces.createWorktree(sessionId);
      const definition = linearCorral(['writer'], 'hashline-unseen-check');
      definition.input = {
        brief: [
          'Work on notes.txt with read_hashline and edit_hashline only.',
          'First call read_hashline on notes.txt with offset 1 and limit 5, and read nothing else before editing.',
          'Then use edit_hashline with the tag you got to replace the line "row 40" with "ROW FORTY".',
          'If the edit result says it was not applied, use the lines it shows and the same tag to make the edit again.',
          'Finally save a one-line summary with write_artifact and call submit_result with its version.',
        ].join(' '),
        criteria: ['Line 40 of notes.txt reads ROW FORTY.'],
      };
      const writer = definition.roles[0]!;
      writer.modelProfile = profile.id;
      writer.allowedWorkTools = ['write_artifact', 'read_file', 'write_file'];
      writer.editingMode = 'hashline';
      const started = server.coordinator.startRun({
        schemaVersion: '0.1',
        commandId: `hashline_${randomUUID()}`,
        definition,
        mode: 'live',
        sessionId,
      });
      if (!started.runId)
        throw new Error(`the run could not start: ${started.receipt.error?.message ?? ''}`);
      runId = started.runId;
      const id = runId;
      const transport = new InProcessTransport(server.coordinator);
      const events: RunEvent[] = [];
      transport.subscribe(id, 0, { onEvent: (event) => events.push(event), onFrame: () => {} });
      const final = await waitForProjection(transport, id, (p) =>
        ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status),
      );
      const edits = events.filter(
        (event): event is Extract<RunEvent, { type: 'tool.requested' }> =>
          event.type === 'tool.requested' && event.payload.name === 'edit_hashline',
      );
      const finished = events.filter((event) => event.type === 'tool.finished');
      const copies = join(root, 'copies');
      const copy = join(copies, readdirSync(copies)[0] ?? '', sessionId);
      const line40 = readFileSync(join(copy, 'notes.txt'), 'utf8').split('\n')[39];
      const report = {
        profile: profileId,
        checkedAt: new Date().toISOString(),
        status: final.status,
        tools: events
          .filter((event) => event.type === 'tool.requested')
          .map((event) => (event.payload as { name: string }).name),
        edits: edits.length,
        failures: finished
          .map((event) => (event.payload as { error: string | null }).error)
          .filter(Boolean),
        line40,
      };
      mkdirSync(join(ROOT, 'test-results/live'), { recursive: true });
      writeFileSync(
        join(ROOT, `test-results/live/hashline-unseen-${profileId}.json`),
        JSON.stringify(report, null, 2),
      );
      expect(edits.length).toBeGreaterThanOrEqual(2);
      expect(line40).toBe('ROW FORTY');
      // No file text in the permanent failure lines.
      for (const failure of report.failures) expect(failure).not.toContain('row 40');
    } finally {
      clearTimeout(deadline);
      stop();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  300000,
);
