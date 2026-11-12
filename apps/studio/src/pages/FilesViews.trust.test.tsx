// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WorkFolderSection } from './FilesViews.tsx';

const fixture = vi.hoisted(() => ({ isGit: true }));
vi.mock('../services.tsx', () => {
  const workspaces = {
    binding: async () => ({
      path: '/folder',
      trusted: false,
      missing: false,
      isGit: fixture.isGit,
      status: fixture.isGit ? { branch: 'main', head: 'abc', changed: 0 } : null,
      verifyCommands: [],
    }),
  };
  return { useServices: () => ({ workspaces, mode: 'server' }) };
});
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => (work: () => Promise<unknown>) => work(),
}));

async function trustCopy(isGit: boolean) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.isGit = isGit;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <WorkFolderSection projectId="project" />
        </IntlProvider>,
      ),
    );
    return {
      text: container.textContent ?? '',
    };
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}

it('a Git repository is trusted as a repository, with what its Git filters may run', async () => {
  const { text } = await trustCopy(true);
  expect(text).toContain(messages.Files.trust);
  expect(text).toContain(messages.Files.trustHint);
  expect(text).not.toContain(messages.Files.trustFolderSwitch);
});

it('a folder that is not a Git repository is trusted as a folder, without Git wording', async () => {
  const { text } = await trustCopy(false);
  expect(text).toContain(messages.Files.trustFolderSwitch);
  expect(text).toContain(messages.Files.trustFolderHint);
  expect(text).not.toContain(messages.Files.trust);
  expect(text).not.toContain('Git filters');
});
