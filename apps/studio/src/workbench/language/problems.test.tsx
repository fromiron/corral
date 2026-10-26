// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SourceNavigationContext } from '../context/SourceAttachments.tsx';
import { ProblemsPanel } from '../ProblemsPanel.tsx';

const fixture = vi.hoisted(() => ({
  documents: {} as object,
  language: {} as object,
  api: {} as object,
}));
vi.mock('../../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaces: fixture.api }),
}));
vi.mock('../documents/store.ts', () => ({
  documentStore: () => fixture.documents,
  documentKey: (_target: unknown, path: string) => path,
}));
vi.mock('./store.ts', () => ({
  languageStore: () => fixture.language,
  languageCopyKey: (target: unknown) => JSON.stringify(target),
}));

it('preserves unversioned structured diagnostics in Problems without claiming they are current', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const target = {
    hostId: 'host',
    projectId: 'project',
    bindingId: 'binding',
    sessionId: 'session',
    copyGeneration: 1,
  };
  const path = 'src/한글 파일.ts';
  const documents = createStore(() => ({
    documents: { [path]: { key: path, target, path, editVersion: 9 } },
  }));
  fixture.documents = Object.assign(documents, { open: vi.fn(async () => path) });
  fixture.language = Object.assign(
    createStore(() => ({
      copies: {
        copy: {
          state: {
            target,
            servers: [{ id: 'typescript', name: 'TypeScript' }],
            session: {
              generation: 'language_one',
              serverId: 'typescript',
              state: 'running',
              diagnostics: [
                {
                  path,
                  documentVersion: null,
                  diagnostics: [
                    {
                      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } },
                      severity: 3,
                      message: 'A structured diagnostic with a space in its path',
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    })),
    { documentVersion: () => 10 },
  );
  fixture.api = {
    languageState: vi.fn(),
    worktree: async () => ({ missing: false }),
    verifications: async () => [],
    tasks: async () => ({ tasks: [] }),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const openDocument = vi.fn(() => true);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <SourceNavigationContext.Provider value={{ openDocument, openTerminal: () => {} }}>
            <ProblemsPanel sessionId="session" />
          </SourceNavigationContext.Provider>
        </IntlProvider>,
      ),
    );
    expect(container.textContent).toContain(messages.Problems.versionUnknown);
    expect(container.textContent).toContain(messages.Problems.severity.info);
    expect(container.textContent).not.toContain(messages.Problems.empty);
    const row = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(path),
    );
    await act(async () => row?.click());
    expect(openDocument).toHaveBeenCalledWith(target, path, {
      startLine: 3,
      startColumn: 5,
      endLine: 3,
      endColumn: 8,
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
