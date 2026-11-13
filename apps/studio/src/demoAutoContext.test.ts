import { describe, expect, it, vi } from 'vitest';
import { demoAutoContext, demoStartAuto } from './demoAutoContext.ts';

// The browser demo admits a request as the server does (apps/server `startAutoRun`): the stored
// session's completion criteria and advisor, read when the request is admitted.

describe('the browser demo’s request context', () => {
  it('carries the session’s advisor and criteria', () => {
    expect(
      demoAutoContext(
        { criteria: ['Tests pass'], advisor: { modelProfile: 'model-a' } },
        { fileTools: true },
      ),
    ).toEqual({
      fileTools: true,
      sessionCriteria: ['Tests pass'],
      sessionAdvisor: { modelProfile: 'model-a' },
    });
  });

  it('leaves out an advisor that is off and criteria that are empty', () => {
    for (const session of [{ advisor: null, criteria: [] }, {}, null])
      expect(demoAutoContext(session, { fileTools: false })).toEqual({ fileTools: false });
  });

  it('passes the request’s signal on', () => {
    const signal = new AbortController().signal;
    expect(demoAutoContext(null, { fileTools: false, signal })).toEqual({
      fileTools: false,
      signal,
    });
  });
});

describe('the browser demo’s start', () => {
  it('reads the session when the request is admitted and starts with its advisor', async () => {
    const start = vi.fn(async () => ({ runId: 'run_1' }) as never);
    const getSession = vi.fn(async () => ({
      criteria: [],
      advisor: { modelProfile: 'model-a' },
    }));
    const startAuto = demoStartAuto({
      worktree: async () => ({}),
      getSession: getSession as never,
      start: start as never,
    });
    const request = { sessionId: 'session_1', commandId: 'cmd_1' } as never;
    const signal = new AbortController().signal;
    await startAuto(request, signal);
    expect(getSession).toHaveBeenCalledWith('session_1');
    expect(start).toHaveBeenCalledWith(request, {
      fileTools: true,
      signal,
      sessionAdvisor: { modelProfile: 'model-a' },
    });
  });

  it('starts without files where the session has no working copy', async () => {
    const start = vi.fn(async () => ({ runId: 'run_1' }) as never);
    const startAuto = demoStartAuto({
      worktree: async () => {
        throw new Error('no copy');
      },
      getSession: (async () => null) as never,
      start: start as never,
    });
    await startAuto({ sessionId: 'session_1' } as never);
    expect(start).toHaveBeenCalledWith({ sessionId: 'session_1' }, { fileTools: false });
  });
});
