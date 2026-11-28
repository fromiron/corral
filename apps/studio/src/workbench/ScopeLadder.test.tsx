// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ScopeLadder } from './ScopeLadder.tsx';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({
    projectId: 'project_1',
    link: (section: string) => ({ to: `/settings/${section}` }),
  }),
}));

const cleanup: (() => void)[] = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

async function show(current: 'personal' | 'project') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ScopeLadder current={current}>
          <select aria-label="choice" />
        </ScopeLadder>
      </IntlProvider>,
    ),
  );
  return container;
}
const { ladder } = messages.Harness;

it('is one list of four rows, each layer named once, in the order a run applies them', async () => {
  const container = await show('personal');
  const rows = [...container.querySelectorAll('ol > li')];
  expect(rows.map((row) => row.querySelector('h4')?.textContent)).toEqual([
    ladder.personal,
    ladder.project,
    ladder.role,
    ladder.run,
  ]);
  for (const name of [ladder.personal, ladder.project, ladder.role, ladder.run])
    expect(container.textContent?.split(name)).toHaveLength(2);
  // What each layer covers and what it replaces stays said.
  expect(rows.map((row) => row.querySelector('p')?.textContent)).toEqual([
    ladder.personalHint,
    ladder.projectHint,
    ladder.roleHint,
    ladder.runHint,
  ]);
  expect(container.textContent).toContain(messages.Harness.ladderRule);
});

it.each([
  ['personal', 0, 1, '/settings/project-defaults'],
  ['project', 1, 0, '/settings/defaults'],
] as const)(
  'puts the %s choice in its own row and links the other default',
  async (current, here, other, address) => {
    const container = await show(current);
    const rows = [...container.querySelectorAll('ol > li')];
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual(
      rows.map((_, index) => (index === here ? 'step' : null)),
    );
    expect(rows.map((row) => row.querySelectorAll('select').length)).toEqual(
      rows.map((_, index) => (index === here ? 1 : 0)),
    );
    expect(rows.map((row) => row.querySelector('a')?.getAttribute('href') ?? null)).toEqual(
      rows.map((_, index) => (index === other ? address : null)),
    );
  },
);
