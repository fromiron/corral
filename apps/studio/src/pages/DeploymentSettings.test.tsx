// @vitest-environment jsdom
import type { HarnessApi } from '@corral/client';
import type { ProjectToolConfigRevision } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DeploymentSettings } from './DeploymentSettings.tsx';

vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: vi.fn(),
  useSettingsTask: () => async (task: () => Promise<unknown>) => task(),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

it('saves deployment edits only on request and preserves existing project tools', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const deployment = {
    id: 'preview',
    name: 'Preview',
    environment: 'test',
    argv: ['node', 'deploy.mjs'],
    readbackArgv: ['node', 'check.mjs'],
    envRefs: ['DEPLOY_TOKEN'],
    timeoutMs: 30000,
  };
  const config = {
    projectId: 'project',
    revision: 3,
    hash: 'a'.repeat(64),
    createdAt: '2026-10-23T00:00:00Z',
    checks: [{ id: 'check', name: 'Check', argv: ['node', 'test.mjs'], timeoutMs: 1000 }],
    lspServers: [],
    mcpServers: [],
    debugConfigurations: [],
    deployments: [deployment],
  } as ProjectToolConfigRevision;
  const saveProjectTools = vi.fn(async (_id, _revision, next) => ({
    ...config,
    ...next,
    revision: 4,
  }));
  const onChange = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <DeploymentSettings
        api={{ saveProjectTools } as unknown as HarnessApi}
        projectId="project"
        config={config}
        onChange={onChange}
      />,
    ),
  );
  const button = (key: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === key,
    );
  expect(saveProjectTools).not.toHaveBeenCalled();
  await act(async () => button('edit')?.click());
  const environment = container.querySelector<HTMLInputElement>('input[name=environment]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter || !environment) throw new Error('Environment input missing');
  await act(async () => {
    setter.call(environment, 'staging');
    environment.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(saveProjectTools).not.toHaveBeenCalled();
  await act(async () => button('save')?.click());
  expect(saveProjectTools).toHaveBeenCalledWith(
    'project',
    3,
    expect.objectContaining({
      checks: config.checks,
      lspServers: [],
      mcpServers: [],
      debugConfigurations: [],
      deployments: [{ ...deployment, environment: 'staging' }],
    }),
  );
  expect(onChange).toHaveBeenCalledOnce();
});
