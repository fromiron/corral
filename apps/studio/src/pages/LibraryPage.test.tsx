// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { LIBRARY_VIEWS, LibraryPage, validateLibrarySearch } from './LibraryPage.tsx';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

it('keeps a project filter and an in-app return address', () => {
  expect(
    validateLibrarySearch({ project: 'project_a', returnTo: '/sessions/session_a#draft' }),
  ).toEqual({ project: 'project_a', returnTo: '/sessions/session_a#draft' });
  for (const search of [
    { project: '' },
    { project: 'x'.repeat(257) },
    { project: ['project_a'] },
    { returnTo: 'https://example.org' },
    { returnTo: '//example.org' },
    { returnTo: '/settings/skills' },
  ])
    expect(validateLibrarySearch(search)).toEqual({});
});

it.each([undefined, ...LIBRARY_VIEWS])('names the %s view from its own messages', async (view) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <LibraryPage view={view} />
      </IntlProvider>,
    ),
  );
  expect(container.querySelector('h2')?.textContent).toBe('Library');
  expect(container.querySelector('main')?.dataset.libraryView).toBe(view);
});
