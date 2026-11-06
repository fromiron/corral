// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_MISSING, sessionFetch } from './sessionConnection.ts';

afterEach(() => vi.unstubAllGlobals());

it('reports expired authentication without retrying or consuming the response', async () => {
  const expired = vi.fn();
  window.addEventListener(SESSION_MISSING, expired);
  const fetcher = vi.fn(async () =>
    Response.json({ error: { code: 'SESSION_INVALID' } }, { status: 401 }),
  );
  vi.stubGlobal('fetch', fetcher);
  try {
    const response = await sessionFetch('/api/v1/projects');
    expect(expired).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ error: { code: 'SESSION_INVALID' } });
  } finally {
    window.removeEventListener(SESSION_MISSING, expired);
  }
});

it('does not treat a denied operation as expired authentication', async () => {
  const expired = vi.fn();
  window.addEventListener(SESSION_MISSING, expired);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 403 })),
  );
  try {
    expect((await sessionFetch('/api/v1/projects')).status).toBe(403);
    expect(expired).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(SESSION_MISSING, expired);
  }
});
