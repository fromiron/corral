import { afterEach, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  resolve: null as null | ((sessionId: string, leaseId: string) => Promise<unknown>),
  close: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('../src/preview.ts', () => ({
  DesktopPreviews: class {
    constructor(resolve: typeof testState.resolve) {
      testState.resolve = resolve;
    }
    open(sessionId: string, leaseId: string) {
      return testState.resolve?.(sessionId, leaseId);
    }
    close(sessionId: string, leaseId: string) {
      testState.close(sessionId, leaseId);
    }
    closeAll() {}
  },
}));
vi.mock('../src/remote-hosts.ts', () => ({ connectRemoteHost: testState.connect }));

import { RemoteHostPreviews } from '../src/remote-host-preview.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  testState.connect.mockReset();
});

function setup() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const origin = 'http://127.0.0.2:49876';
  const lease = {
    leaseId: 'preview_one',
    sessionId: 'session_one',
    state: 'ready',
    kind: 'static',
    origin,
    url: `${origin}/${'a'.repeat(43)}/index.html`,
  };
  let ready = true;
  let lists = 0;
  const delegates: unknown[] = [];
  testState.connect.mockImplementation(async (_host, options) => {
    let connected = true;
    return {
      connected,
      close: async () => {
        connected = false;
        options.onDisconnect();
      },
    };
  });
  const previews = new RemoteHostPreviews({
    host: {
      id: 'host_00000000-0000-0000-0000-000000000000',
      name: 'Host',
      sshAlias: 'host',
      port: 4317,
    },
    sshExecutable: 'unused',
    sshConfig: 'unused',
    signal: new AbortController().signal,
    pinIdentity: () => {},
    session: {
      fetch: async (url: string, options?: RequestInit) => {
        if (url.endsWith('/previews')) {
          lists++;
          return Response.json(ready ? [lease] : []);
        }
        if (url.endsWith('/session')) return Response.json({ csrfToken: 'csrf' });
        if (url.endsWith('/delegations')) {
          delegates.push(JSON.parse(String(options?.body)));
          return Response.json({
            delegationId: 'delegation_one',
            // Deliberately a different machine's wall clock: only validity of the format matters.
            expiresAt: '2000-01-01T00:01:00.000Z',
            target: {
              url: lease.url,
              origin,
              webSocketOrigins: [],
              headers: { 'x-corral-preview': 'stable-token' },
            },
          });
        }
        throw new Error('Unexpected endpoint');
      },
    } as never,
  });
  return {
    previews,
    delegates,
    revoke: () => {
      ready = false;
    },
    lists: () => lists,
  };
}

it('renewal uses a 20-second monotonic deadline and preserves target headers', async () => {
  const state = setup();
  try {
    const first = await state.previews.open('session_one', 'preview_one');
    await vi.advanceTimersByTimeAsync(19000);
    await testState.resolve?.('session_one', 'preview_one');
    expect(state.delegates).toEqual([{}]);
    await vi.advanceTimersByTimeAsync(1000);
    const renewed = await testState.resolve?.('session_one', 'preview_one');
    expect(state.delegates).toEqual([{}, { delegationId: 'delegation_one' }]);
    expect(renewed).toEqual(first);
  } finally {
    await state.previews.close();
  }
});

it('a failed forward releases its delegation and a retry requests a fresh one', async () => {
  const state = setup();
  testState.connect.mockRejectedValueOnce(new Error('port occupied'));
  try {
    await expect(state.previews.open('session_one', 'preview_one')).rejects.toThrow(
      'port occupied',
    );
    const before = state.lists();
    await vi.advanceTimersByTimeAsync(15000);
    expect(state.lists()).toBe(before);
    expect(testState.close).toHaveBeenCalledWith('session_one', 'preview_one');
    await state.previews.open('session_one', 'preview_one');
    expect(state.delegates).toEqual([{}, {}]);
  } finally {
    await state.previews.close();
  }
});

it('revoked leases close their own window and stop polling the inactive session', async () => {
  const state = setup();
  try {
    await state.previews.open('session_one', 'preview_one');
    state.revoke();
    await vi.advanceTimersByTimeAsync(5000);
    expect(testState.close).toHaveBeenCalledWith('session_one', 'preview_one');
    const before = state.lists();
    await vi.advanceTimersByTimeAsync(15000);
    expect(state.lists()).toBe(before);
  } finally {
    await state.previews.close();
  }
});
