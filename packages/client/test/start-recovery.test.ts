import { expect, it } from 'vitest';
import { HttpSseTransport } from '../src/index.ts';
import { createStartRecovery } from '../src/recovery.ts';

it.each(['auto', 'explain'] as const)(
  '[TC-ABS-014-N] %s recovers a lost start response when a retry supplies a fresh ID',
  async (kind) => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    let posts = 0;
    const receipts = new Map<string, { runId: string; receipt: { commandId: string } }>();
    const http: typeof fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/session')) return Response.json({ csrfToken: 'fixture' });
      if (path.includes('/start-commands/')) {
        const receipt = receipts.get(path.split('/').at(-1) ?? '');
        return receipt ? Response.json(receipt) : new Response(null, { status: 404 });
      }
      expect(init.method).toBe('POST');
      const { commandId } = JSON.parse(String(init.body));
      const result = { runId: `run_${++posts}`, receipt: { commandId } };
      receipts.set(commandId, result);
      if (posts === 1) throw new TypeError('response lost after commit');
      return Response.json(result);
    };
    const transport = () =>
      new HttpSseTransport(
        { baseUrl: 'http://fixture.invalid', fetch: http },
        {
          commands: { commands: () => [], pending: () => {}, confirmed: () => {} },
          starts: createStartRecovery(storage, 'host_one'),
        },
      );
    const start = (client: HttpSseTransport, commandId: string) =>
      kind === 'auto'
        ? client.startAuto({
            commandId,
            sessionId: 'session_one',
            brief: 'Fixture request',
            choice: { modelProfile: 'primary' },
            mode: 'mock',
          })
        : client.startExplain({
            commandId,
            sessionId: 'session_one',
            question: 'Fixture question',
            modelProfile: 'primary',
            mode: 'mock',
          });
    await expect(start(transport(), 'cmd_original')).rejects.toThrow('response lost');
    expect((await start(transport(), 'cmd_new')).runId).toBe('run_1');
    expect(posts).toBe(1);
    expect(storage.getItem('corral:start-recovery:v1:host_one')).toBe('{}');
  },
);

it('[TC-ABS-014-N] cancelling a fresh-ID retry targets the original pending Auto start', async () => {
  const values = new Map<string, string>();
  const starts = createStartRecovery(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    },
    'host_one',
  );
  const original = {
    commandId: 'cmd_original',
    sessionId: 'session_one',
    brief: 'Fixture',
    choice: { modelProfile: 'primary' },
    mode: 'mock' as const,
  };
  starts.pending('/runs/auto', original);
  let resolveLookup: (response: Response) => void = () => {};
  const lookup = new Promise<Response>((resolve) => {
    resolveLookup = resolve;
  });
  const paths: string[] = [];
  const client = new HttpSseTransport(
    {
      baseUrl: 'http://fixture.invalid',
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path.endsWith('/session')) return Response.json({ csrfToken: 'fixture' });
        if (path.includes('/start-commands/')) return lookup;
        return Response.json({ start: null, cancellation: null });
      },
    },
    { commands: { commands: () => [], pending: () => {}, confirmed: () => {} }, starts },
  );
  const start = client.startAuto({ ...original, commandId: 'cmd_fresh' });
  try {
    await client.cancelAuto({
      commandId: 'cmd_fresh',
      sessionId: 'session_one',
      cancelCommandId: 'cmd_cancel',
    });
    expect(paths).toContain('/api/v1/runs/auto/cmd_original/cancel');
    expect(paths).not.toContain('/api/v1/runs/auto/cmd_fresh/cancel');
  } finally {
    resolveLookup(Response.json({ runId: 'run_one', receipt: { commandId: 'cmd_original' } }));
    await start;
  }
});

it('[TC-ABS-014-H] an explicit retry recovers only the exact unresolved saved request in this host', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const original = {
    commandId: 'cmd_original',
    schemaVersion: '0.1',
    corralId: 'corral_one',
    definitionRevision: 3,
    mode: 'mock',
    startFrom: { runId: 'run_previous', artifactVersionId: 'artifact_one' },
    harnessOverrides: { profileId: 'profile_one' },
  };
  createStartRecovery(storage, 'host_one').pending('/runs', original);
  const fresh = { ...original, commandId: 'cmd_new' };
  const journal = createStartRecovery(storage, 'host_one');
  expect(journal.prepare('/runs', fresh)).toEqual(original);
  expect(createStartRecovery(storage, 'host_other').prepare('/runs', fresh)).toEqual(fresh);
  for (const changed of [
    { ...fresh, definitionRevision: 4 },
    { ...fresh, mode: 'live' },
    { ...fresh, corralId: 'corral_two' },
    { ...fresh, startFrom: { ...fresh.startFrom, artifactVersionId: 'artifact_two' } },
    { ...fresh, harnessOverrides: { profileId: 'profile_two' } },
  ])
    expect(journal.prepare('/runs', changed)).toEqual(changed);
  expect(journal.prepare('/runs/auto', fresh)).toEqual(fresh);
  journal.confirmed(original.commandId);
  expect(journal.prepare('/runs', fresh)).toEqual(fresh);
});
