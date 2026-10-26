// @vitest-environment jsdom
import type { HarnessApi } from '@corral/client';
import type { ProjectToolConfig, ProjectToolConfigRevision } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ProjectToolSettings } from './ProjectToolSettings.tsx';

vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock('../services.tsx', () => ({ useServices: () => ({}) }));
vi.mock('./FilesViews.tsx', () => ({ WORKSPACE_CHANGED: 'corral:workspace-changed' }));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => async (task: () => Promise<void>) => task(),
}));

it('editing language tools preserves debugger and deployment configuration with the same revision guard', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const config = {
    projectId: 'project',
    revision: 3,
    hash: 'a'.repeat(64),
    createdAt: '2026-10-23T00:00:00Z',
    checks: [],
    mcpServers: [],
    lspServers: [
      {
        id: 'typescript',
        name: 'TypeScript',
        argv: ['typescript-language-server', '--stdio'],
        languageIds: ['typescript'],
        fileExtensions: ['.ts'],
        timeoutMs: 30000,
      },
    ],
    debugAdapters: [
      { id: 'js_debug', name: 'JavaScript', argv: ['node', 'adapter.js'], timeoutMs: 30000 },
    ],
    debugConfigurations: [
      {
        id: 'debug_app',
        name: 'App',
        adapterId: 'js_debug',
        runtime: 'node',
        request: 'launch',
        program: 'app.js',
        cwd: '.',
        args: [],
        envRefs: [],
      },
    ],
    deployments: [
      {
        id: 'deploy_test',
        name: 'Test',
        environment: 'local',
        argv: ['node', 'deploy.js'],
        readbackArgv: ['node', 'read.js'],
        timeoutMs: 30000,
        envRefs: [],
      },
    ],
  };
  const saveProjectTools = vi.fn(
    async (_projectId: string, _revision: number, _values: ProjectToolConfig) => config,
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ProjectToolSettings
          api={{ saveProjectTools } as unknown as HarnessApi}
          projectId="project"
          config={config as unknown as ProjectToolConfigRevision}
          onChange={() => {}}
        />,
      ),
    );
    const remove = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Harness.removeLsp',
    );
    expect(remove).toBeDefined();
    await act(async () => remove?.click());
    expect(saveProjectTools).toHaveBeenCalledWith('project', 3, {
      checks: [],
      mcpServers: [],
      lspServers: [],
      debugAdapters: config.debugAdapters,
      debugConfigurations: config.debugConfigurations,
      deployments: config.deployments,
    });
    const editConfiguration = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.textContent === 'DebuggerSettings.edit' &&
        button.parentElement?.textContent?.includes('App · node'),
    );
    await act(async () => editConfiguration?.click());
    const saveDebugger = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'DebuggerSettings.save',
    );
    expect(saveDebugger?.disabled).toBe(false);
    await act(async () => saveDebugger?.click());
    const saved = saveProjectTools.mock.calls.at(-1)?.[2] as ProjectToolConfigRevision | undefined;
    expect(saved?.debugConfigurations?.[0]).not.toHaveProperty('outFiles');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
