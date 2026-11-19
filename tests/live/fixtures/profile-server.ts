import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { parseWorkspaceConfig } from '@corral/core';
import { type CorralServer, createLiveModels, startCorralServer } from '@corral/server';
import { ROOT } from '../../../tools/release/candidate.ts';

export interface LiveProfileServer {
  server: CorralServer;
  api(path: string, body?: unknown, method?: string): Promise<Response>;
}

export function writeLiveResults(out: string | undefined, results: readonly unknown[]) {
  if (!out) return;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ results }, null, 2)}\n`);
}

/** One supervised live session: only this profile, an ephemeral port and no mock fallback. */
export async function withLiveProfile(
  profileId: string,
  deadlineMs: number,
  work: (session: LiveProfileServer) => Promise<void>,
  live = createLiveModels(),
) {
  const configPath = process.env.CORRAL_LIVE_CONFIG ?? join(ROOT, '.corral/config.json');
  const parsed = parseWorkspaceConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  if (!parsed.ok) throw new Error('Invalid live model configuration');
  const profile = parsed.config.modelProfiles?.find((item) => item.id === profileId);
  if (!profile) throw new Error('Selected live profile not found');
  const directory = mkdtempSync(join(tmpdir(), 'corral-live-profile-'));
  let server: CorralServer | undefined;
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    if (!server) return;
    for (const run of server.coordinator.listRuns()) {
      if (!TERMINAL_RUN_STATUSES.has(run.status))
        server.coordinator.submit({
          schemaVersion: '0.1',
          commandId: `cancel_${randomUUID()}`,
          runId: run.runId,
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'Manual provider check closed' },
        });
    }
  };
  const deadline = setTimeout(stop, deadlineMs);
  try {
    mkdirSync(join(directory, '.corral'));
    writeFileSync(
      join(directory, '.corral/config.json'),
      JSON.stringify({
        schemaVersion: '0.1',
        modelProfiles: [profile],
        modelProviders: parsed.config.modelProviders?.filter((row) => row.id === profile.provider),
      }),
    );
    server = await startCorralServer({
      workspace: directory,
      port: 0,
      live,
      agents: {
        start: async () => {
          throw new Error('A live check cannot use the mock adapter');
        },
      },
      worktreeRoot: join(directory, 'worktrees'),
      bootstrapToken: randomUUID(),
    });
    const url = `${server.url}/api/v1`;
    const headers = new Headers({ origin: server.url, 'content-type': 'application/json' });
    const login = await fetch(`${url}/session`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        token: new URL(server.bootstrapUrl).hash.slice('#bootstrap='.length),
      }),
    });
    if (login.status !== 204) throw new Error(`Live server login returned ${login.status}`);
    headers.set('cookie', (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '');
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    await work({
      server,
      api: (path, body, method = body === undefined ? 'GET' : 'POST') =>
        fetch(url + path, {
          method,
          headers,
          signal: controller.signal,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
    });
    controller.signal.throwIfAborted();
  } finally {
    clearTimeout(deadline);
    stop();
    try {
      await server?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
