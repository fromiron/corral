// @vitest-environment jsdom

import type { MeetingConfig } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProfileInfo } from './useModels.ts';

const state = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  profiles: null as ProfileInfo[] | null,
}));
vi.mock('use-intl', () => ({
  useTranslations: () => (key: string, values?: { number?: number }) =>
    `${key}${values?.number ?? ''}`,
}));
vi.mock('../services.tsx', () => ({ useServices: () => state.services }));
vi.mock('./useModels.ts', () => ({ useModelProfiles: () => state.profiles }));
vi.mock('../projects.ts', () => ({ projectsChanged: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@corral/react/ui', () => ({
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogPopup: ({ children }: any) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  Select: ({ label, options, value, onValueChange }: any) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="" />
      {options.map((option: any) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
const { StartMeeting } = await import('./NewMeeting.tsx');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function mount(profiles: ProfileInfo[] | null, live = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const createSession = vi.fn(async (_input: { meeting: MeetingConfig }) => ({
    ok: true,
    session: { sessionId: 'meeting_1' },
  }));
  state.profiles = profiles;
  state.services = { mode: live ? 'server' : 'browser', live, repository: { createSession } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async () => act(async () => root.render(<StartMeeting projectId="project_1" />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render();
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === label);
  await act(async () => button('new')!.click());
  return { container, button, render, createSession };
}
const profile = (profileId: string, available = true): ProfileInfo => ({
  profileId,
  label: profileId,
  available,
});

it('[TC-MEET-001-N] live creation waits for real profiles and fills them when loading finishes', async () => {
  const f = await mount(null);
  expect(f.button('create')?.disabled).toBe(true);
  expect(f.container.textContent).not.toContain('model-a');
  state.profiles = [profile('connected')];
  await f.render();
  expect(f.button('create')?.disabled).toBe(false);
  await act(async () =>
    f.container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(f.createSession).toHaveBeenCalledWith(
    expect.objectContaining({
      meeting: expect.objectContaining({
        participants: expect.arrayContaining([
          expect.objectContaining({ modelProfile: 'connected' }),
        ]),
      }),
    }),
  );
});

it('[TC-MEET-001-F] unavailable roles remain visible until the person removes them before creation', async () => {
  const f = await mount([profile('ready'), profile('offline', false)]);
  const model = f.container.querySelector<HTMLSelectElement>(
    'select[aria-label="participantModel3"]',
  )!;
  await act(async () => {
    model.value = 'offline';
    model.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(f.container.textContent).toContain('unavailableParticipants');
  expect(f.button('create')?.disabled).toBe(true);
  await act(async () => f.button('removeUnavailable')?.click());
  expect(f.button('create')?.disabled).toBe(false);
  await act(async () =>
    f.container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  const meeting = f.createSession.mock.calls[0]?.[0].meeting;
  expect(meeting?.participants).toHaveLength(2);
  expect(meeting?.participants.every((item) => item.modelProfile === 'ready')).toBe(true);
});
