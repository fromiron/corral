// @vitest-environment jsdom
import type { MeetingView } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };

const fixture = vi.hoisted(() => ({ services: {} as any }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('./useModels.ts', () => ({ useModelProfiles: () => null }));
vi.mock('./AutoModelMenu.tsx', () => ({ AutoModelMenu: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: any) => <a href="/">{children}</a>,
}));
vi.mock('@corral/react/design-kit', () => ({
  fontWeights: { normal: '', semibold: '', bold: '' },
  Input: (props: any) => <input {...props} />,
  Textarea: (props: any) => <textarea {...props} />,
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Select: ({ label, value, options, onValueChange, ...props }: any) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      {...props}
    >
      {options.map((o: any) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
const { MeetingHandoff } = await import('./MeetingHandoff.tsx');

const now = new Date('2026-11-15T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  window.localStorage.clear();
});

async function targetOptions(locale: 'en' | 'ko', sessions: Partial<WorkSession>[]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const messages = locale === 'ko' ? ko : en;
  fixture.services = {
    mode: 'server',
    live: false,
    meetingHandoffs: {
      send: vi.fn(),
      receipt: vi.fn(async () => ({ handoff: null })),
      list: vi.fn(async () => ({ handoffs: [] })),
      cancel: vi.fn(),
      start: vi.fn(),
      rediscuss: vi.fn(),
    },
    repository: {
      list: vi.fn(async () => []),
      listSessions: vi.fn(async () =>
        sessions.map((item) => ({ projectId: 'project', archivedAt: null, ...item })),
      ),
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale={locale} messages={messages} timeZone="UTC" now={now}>
        <MeetingHandoff
          session={{ sessionId: 'meeting', projectId: 'project' } as WorkSession}
          decision={
            { versionId: 'v1', content: { goal: 'Do work' } } as NonNullable<
              MeetingView['decisions']
            >[number]
          }
          onChange={async () => {}}
        />
      </IntlProvider>,
    ),
  );
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const open = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === messages.MeetingsHandoff.open,
  );
  await act(async () => open?.click());
  const select = container.querySelector(`select[aria-label="${messages.MeetingsHandoff.target}"]`);
  return [...(select?.querySelectorAll('option') ?? [])].map((option) => [
    option.value,
    option.textContent,
  ]);
}

it.each([
  ['en', 'Create new conversation', 'New conversation'],
  ['ko', '새 대화 만들기', '새 대화'],
] as const)(
  'the first target makes a new conversation and one untitled conversation reads bare (%s)',
  async (locale, create, untitled) => {
    expect(
      await targetOptions(locale, [
        { sessionId: 'a', title: untitled, updatedAt: hoursAgo(2) },
        { sessionId: 'b', title: 'Release notes', updatedAt: hoursAgo(3) },
      ]),
    ).toEqual([
      ['new', create],
      ['a', untitled],
      ['b', 'Release notes'],
    ]);
  },
);

/** The date and time to the minute, as the app formats it in the provider's zone (UTC). */
const stamp = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(iso));

it.each([
  ['en', 'New conversation'],
  ['ko', '새 대화'],
] as const)(
  'same-titled targets add their last activity to the minute, a unique title stays bare (%s)',
  async (locale, untitled) => {
    // Two hours and some minutes ago both: a relative time would read the same for both.
    const first = new Date(now.getTime() - 130 * 60_000).toISOString();
    const second = new Date(now.getTime() - 160 * 60_000).toISOString();
    const options = await targetOptions(locale, [
      { sessionId: 'a', title: untitled, updatedAt: first },
      { sessionId: 'b', title: untitled, updatedAt: second },
      { sessionId: 'c', title: 'Release notes', updatedAt: hoursAgo(4) },
    ]);
    expect(options.slice(1)).toEqual([
      ['a', `${untitled} · ${stamp(locale, first)}`],
      ['b', `${untitled} · ${stamp(locale, second)}`],
      ['c', 'Release notes'],
    ]);
    expect(options[1]?.[1]).not.toBe(options[2]?.[1]);
  },
);
