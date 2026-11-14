// @vitest-environment jsdom
import type { ChangeSetView } from '@corral/client';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { RunChanges } from './RunChanges.tsx';

// The run's change chip: how many files the run changed, with their line counts when it changed
// any.

const services = vi.hoisted(() => ({
  workspaces: { changes: (() => {}) as unknown as () => Promise<ChangeSetView> },
}));
const changes = vi.fn<() => Promise<ChangeSetView>>();
services.workspaces.changes = changes;
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children?: ReactNode }) => (
    <a href="/review" {...props}>
      {children}
    </a>
  ),
}));

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  changes.mockReset();
});

const file = (path: string, additions: number, deletions: number) =>
  ({ path, additions, deletions }) as ChangeSetView['files'][number];

async function chip(files: ChangeSetView['files'], locale: 'en' | 'ko' = 'en') {
  changes.mockResolvedValue({ from: 'a', to: 'b', unavailable: null, files });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale={locale} messages={locale === 'en' ? messages : ko} timeZone="UTC">
        <RunChanges sessionId="session" runId="run" />
      </IntlProvider>,
    ),
  );
  return container.querySelector('[data-testid="run-change-summary"]')?.textContent;
}

it.each([
  ['en', 'No changes'],
  ['ko', '변경 없음'],
] as const)('a run that changed no file says only that (%s)', async (locale, words) => {
  expect(await chip([], locale)).toBe(words);
});

it.each([
  ['en', '2 changed files · +5 −1'],
  ['ko', '바뀐 파일 2개 · +5 −1'],
] as const)('a run that changed files counts them and their lines (%s)', async (locale, words) => {
  expect(await chip([file('a.ts', 3, 1), file('b.ts', 2, 0)], locale)).toBe(words);
});
