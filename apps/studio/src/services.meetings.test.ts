// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createStudioServices } from './services.tsx';

// The browser runtime (the demo) answers a meeting's continue with its own meeting service, as
// the server does: what it says comes from the meeting, not from a stand-in.

// The simulated runs live in a worker, which a continue never reaches.
vi.stubGlobal(
  'Worker',
  class {
    postMessage() {}
    addEventListener() {}
    terminate() {}
  },
);

afterEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

it('the browser runtime continues a held chain through its meeting service', async () => {
  window.history.replaceState(null, '', '/demo');
  const services = await createStudioServices();
  expect(services.mode).toBe('browser');
  // No such meeting: the service says so; nothing claims it went on.
  await expect(
    services.meetings.continueChain('session_missing', { commandId: 'continue_1' }),
  ).resolves.toMatchObject({ ok: false, error: 'not_found' });
  services.disposeRuns();
});
