import { describe, expect, it } from 'vitest';
import { demoAutoContext } from './demoAutoContext.ts';

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
