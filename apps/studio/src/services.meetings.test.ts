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

it.each([
  ['/', true],
  ['/demo', false],
] as const)(
  'keeps project originals with the teams of browser mode %s',
  async (path, persistent) => {
    window.history.replaceState(null, '', path);
    const services = await createStudioServices();
    const project = await services.repository.createProject({ name: 'My project' });
    if (!project.ok) throw new Error(project.message);
    const { projectId } = project.project;
    const made = await services.agents.create(projectId, {
      operationId: 'save_writer',
      role: {
        name: 'Writer',
        prompt: 'Write.',
        modelProfile: 'model-a',
        outputContract: 'draft',
        allowedWorkTools: [],
        allowedCollaborationTools: [],
      },
    });
    if (!made.ok) throw new Error(made.message);
    expect(await services.agents.list(projectId)).toEqual([made.agent]);
    services.disposeRuns();
    const reopened = await createStudioServices();
    expect(reopened.persistent).toBe(persistent);
    expect(await reopened.agents.list(projectId)).toEqual(persistent ? [made.agent] : []);
    reopened.disposeRuns();
  },
);
