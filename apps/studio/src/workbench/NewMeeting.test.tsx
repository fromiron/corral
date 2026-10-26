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
vi.mock('@corral/react/design-kit', () => ({
  Input: (props: any) => <input {...props} />,
  Textarea: (props: any) => <textarea {...props} />,
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

async function submit(f: Awaited<ReturnType<typeof mount>>) {
  await act(async () =>
    f.container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  return f.createSession.mock.calls.at(-1)?.[0].meeting;
}

it('starts a general chat with distinct model names and optional blank roles', async () => {
  const f = await mount([
    { ...profile('gpt'), label: 'OpenAI · GPT' },
    { ...profile('deepseek'), label: 'Hive · DeepSeek' },
  ]);
  const roles = [...f.container.querySelectorAll('textarea')];
  expect(roles.map((role) => role.value)).toEqual(['', '', '']);
  expect(roles.every((role) => !role.required)).toBe(true);
  const meeting = await submit(f);
  expect(
    meeting?.participants.map(({ name, prompt, modelProfile }) => ({ name, prompt, modelProfile })),
  ).toEqual([
    { name: 'OpenAI · GPT', prompt: '', modelProfile: 'gpt' },
    { name: 'Hive · DeepSeek', prompt: '', modelProfile: 'deepseek' },
    { name: 'OpenAI · GPT (2)', prompt: '', modelProfile: 'gpt' },
  ]);
});

it('development roles are explicit and stay editable', async () => {
  const f = await mount([profile('connected')]);
  expect(f.button('applyDevelopmentRoles')).toBeDefined();
  await act(async () => f.button('applyDevelopmentRoles')!.click());
  const names = [...f.container.querySelectorAll<HTMLInputElement>('fieldset input')];
  expect(names.map((input) => input.value)).toEqual([
    'template.architect.name',
    'template.builder.name',
    'template.tester.name',
  ]);
  const role = f.container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      names[0],
      'Designer',
    );
    names[0]!.dispatchEvent(new Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      role,
      'Discuss user needs.',
    );
    role.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const meeting = await submit(f);
  expect(meeting?.participants[0]).toMatchObject({
    name: 'Designer',
    prompt: 'Discuss user needs.',
  });
  expect(meeting?.participants[1]?.prompt).toBe('template.builder.role');
  expect(meeting?.participants[2]?.prompt).toBe('template.tester.role');
});

it('changing models updates only automatic names', async () => {
  const f = await mount([profile('first'), profile('second')]);
  const names = [...f.container.querySelectorAll<HTMLInputElement>('fieldset input')];
  const models = [...f.container.querySelectorAll<HTMLSelectElement>('fieldset select')];
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      names[1],
      'Partner',
    );
    names[1]!.dispatchEvent(new Event('input', { bubbles: true }));
    models[0]!.value = 'second';
    models[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    models[1]!.value = 'first';
    models[1]!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const meeting = await submit(f);
  expect(meeting?.participants.map((item) => item.name)).toEqual(['second', 'Partner', 'first']);
});

it('repeated long model labels fit the distinct participant name contract', async () => {
  const f = await mount([
    { ...profile('connected'), label: 'Provider · very-long-model-name'.repeat(3) },
  ]);
  await act(async () => f.button('addParticipant')!.click());
  const names = (await submit(f))!.participants.map((item) => item.name);
  expect(names).toHaveLength(4);
  expect(new Set(names).size).toBe(names.length);
  expect(names.every((name) => name.length > 0 && name.length <= 40)).toBe(true);
});

it('live creation waits for real profiles and fills them when loading finishes', async () => {
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

it('unavailable roles remain visible until the person removes them before creation', async () => {
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
