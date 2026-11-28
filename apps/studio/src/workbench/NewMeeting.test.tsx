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
vi.mock('@corral/react/design-kit', async (importOriginal) => ({
  fontWeights: (await importOriginal<typeof import('@corral/react/design-kit')>()).fontWeights,
  Input: (props: any) => <input {...props} />,
  Textarea: (props: any) => <textarea {...props} />,
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogPopup: ({ children }: any) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  ScrollArea: ({ children }: any) => <div data-scrolls>{children}</div>,
  Collapse: ({ id, open, children }: any) => (
    <div id={id} inert={!open || undefined}>
      {children}
    </div>
  ),
  Tooltip: ({ children }: any) => children,
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
// The searchable model field, as a native select over the same rows.
vi.mock('@corral/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@corral/react')>()),
  ModelSelect: ({ label, options, value, onValueChange }: any) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="" />
      {options.map((option: any) => (
        <option key={option.id} value={option.id}>
          {option.name}
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

/** The text nodes a sighted person reads, without the select's option lists. */
function visibleTexts(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue?.trim();
    if (text && !node.parentElement?.closest('option, .sr-only')) texts.push(text);
  }
  return texts;
}

/** The fields a person can reach: a folded participant's own stay in the page but inert. */
const shownFields = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>('input, select, textarea')].filter(
    (field) => !field.closest('[inert], [hidden]'),
  );

const fold = (f: { container: Element }, number: number) =>
  f.container.querySelector<HTMLButtonElement>(`button[aria-label="participantDetails${number}"]`)!;

async function unfold(f: { container: Element }, number: number) {
  await act(async () => fold(f, number).click());
}

const labelText = (ids: string) =>
  ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ');

function accessibleName(element: Element) {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) return labelText(labelledBy);
  const label = element.getAttribute('aria-label');
  if (label) return label;
  const labels = (element as HTMLInputElement).labels;
  if (labels?.length) return [...labels].map((item) => item.textContent?.trim()).join(' ');
  return element.textContent?.trim() ?? '';
}

/** The name of the participant group a field sits in. */
function groupName(element: Element) {
  const group = element.closest('fieldset fieldset, [role="group"]');
  if (!group) return null;
  const labelledBy = group.getAttribute('aria-labelledby');
  if (labelledBy) return labelText(labelledBy);
  return (
    group.getAttribute('aria-label') ??
    group.querySelector(':scope > legend')?.textContent?.trim() ??
    null
  );
}

it('shows the meeting name, each participant’s name and model, the secretary model and the two buttons first', async () => {
  const f = await mount([profile('connected')]);
  expect(shownFields(f.container).map(accessibleName)).toEqual([
    'title',
    'participantName1',
    'participantModel1',
    'participantName2',
    'participantModel2',
    'participantName3',
    'participantModel3',
    'secretaryModel',
  ]);
  expect(f.button('cancel')).toBeDefined();
  expect(f.button('create')).toBeDefined();
  expect([1, 2, 3].map((number) => fold(f, number).getAttribute('aria-expanded'))).toEqual([
    'false',
    'false',
    'false',
  ]);
});

it('opens one participant’s nicknames, role label and role description from its row', async () => {
  const f = await mount([profile('connected')]);
  await unfold(f, 2);
  expect(fold(f, 2).getAttribute('aria-expanded')).toBe('true');
  const opened = document.getElementById(fold(f, 2).getAttribute('aria-controls') ?? '');
  expect(opened && shownFields(opened).map(accessibleName)).toEqual([
    'participantAliases2',
    'participantRoleTag2',
    'participantRoleDescription2',
  ]);
  expect(shownFields(f.container)).toHaveLength(11);
  await unfold(f, 2);
  expect(fold(f, 2).getAttribute('aria-expanded')).toBe('false');
  expect(shownFields(f.container)).toHaveLength(8);
});

it('names no participant in the form’s text, and every control keeps a distinct accessible name', async () => {
  const f = await mount([
    { ...profile('first'), label: 'First model' },
    { ...profile('second'), label: 'Second model' },
  ]);
  const form = f.container.querySelector('form');
  if (!form) throw new Error('Missing the new meeting form');
  // A row is its name and model; the number is in the controls' names only.
  expect(visibleTexts(form).filter((text) => /\d/.test(text))).toEqual([]);
  // The two column words show once, above the rows.
  expect(visibleTexts(form).filter((text) => text === 'nameLabel')).toHaveLength(1);
  expect(visibleTexts(form).filter((text) => text === 'modelLabel')).toHaveLength(1);
  // The comma rule and what callings do sit in the nickname field, not in a sentence above it.
  expect(form.textContent).not.toContain('participantAliasesHint');
  const controls = [...form.querySelectorAll('input, textarea, select, button')];
  const names = controls.map(accessibleName);
  expect(new Set(names).size).toBe(names.length);
  for (const number of [1, 2, 3]) {
    const own = [
      `participantName${number}`,
      `participantModel${number}`,
      `participantDetails${number}`,
      `participantAliases${number}`,
      `participantRoleTag${number}`,
      `participantRoleDescription${number}`,
      `removeParticipant${number}`,
    ].map((name) => controls[names.indexOf(name)]);
    expect(own.every(Boolean)).toBe(true);
    for (const control of own as Element[])
      expect(groupName(control)).toBe(`participantDefault${number}`);
    const [, , details, aliases, , , remove] = own as [
      Element,
      Element,
      Element,
      HTMLInputElement,
      Element,
      Element,
      Element,
    ];
    expect(aliases.placeholder).toBe('aliasesPlaceholder');
    // The fold and Remove are icon buttons: their names are for assistive technology.
    expect(details.textContent?.trim()).toBe('');
    expect(remove.textContent?.trim()).toBe('');
  }
});

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

it('saves what the person calls each participant, and leaves it out when blank', async () => {
  const f = await mount([profile('connected')]);
  const aliases = [
    ...f.container.querySelectorAll<HTMLInputElement>('input[aria-label^="participantAliases"]'),
  ];
  const names = [...f.container.querySelectorAll<HTMLInputElement>('fieldset input[required]')];
  expect(aliases).toHaveLength(3);
  expect(shownFields(f.container)).not.toContain(aliases[0]);
  await unfold(f, 1);
  expect(shownFields(f.container)).toContain(aliases[0]);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      aliases[0],
      ` 루나, Luna ,luna,, ${names[0]!.value} `,
    );
    aliases[0]!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Folding it again keeps what was written.
  await unfold(f, 1);
  expect(shownFields(f.container)).not.toContain(aliases[0]);
  const meeting = await submit(f);
  expect(meeting?.participants[0]?.aliases).toEqual(['루나', 'Luna']);
  expect(meeting?.participants[1]).not.toHaveProperty('aliases');
});

it('saves a short role label and leaves it out when blank', async () => {
  const f = await mount([profile('connected')]);
  const roles = [
    ...f.container.querySelectorAll<HTMLInputElement>('input[aria-label^="participantRoleTag"]'),
  ];
  expect(roles).toHaveLength(3);
  expect(roles.every((role) => role.maxLength === 40)).toBe(true);
  const descriptions = [...f.container.querySelectorAll('textarea')];
  expect(descriptions.map((item) => item.getAttribute('aria-label'))).toEqual([
    'participantRoleDescription1',
    'participantRoleDescription2',
    'participantRoleDescription3',
  ]);
  await unfold(f, 1);
  expect(shownFields(f.container)).toContain(roles[0]);
  expect(shownFields(f.container)).toContain(descriptions[0]);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      roles[0],
      '  설계  ',
    );
    roles[0]!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const meeting = await submit(f);
  expect(meeting?.participants[0]?.role).toBe('설계');
  expect(meeting?.participants[0]?.prompt).toBe('');
  expect(meeting?.participants[1]).not.toHaveProperty('role');
});

it('development roles are explicit and stay editable', async () => {
  const f = await mount([profile('connected')]);
  expect(f.button('applyDevelopmentRoles')).toBeDefined();
  await act(async () => f.button('applyDevelopmentRoles')!.click());
  const names = [...f.container.querySelectorAll<HTMLInputElement>('fieldset input[required]')];
  expect(names.map((input) => input.value)).toEqual([
    'template.architect.name',
    'template.builder.name',
    'template.tester.name',
  ]);
  const role = f.container.querySelector('textarea')!;
  // What it wrote is open to read and edit, on the three participants it wrote to.
  expect([1, 2, 3].map((number) => fold(f, number).getAttribute('aria-expanded'))).toEqual([
    'true',
    'true',
    'true',
  ]);
  expect(
    shownFields(f.container)
      .filter((field) => field.tagName === 'TEXTAREA')
      .map((field) => (field as HTMLTextAreaElement).value),
  ).toEqual(['template.architect.role', 'template.builder.role', 'template.tester.role']);
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
  const f = await mount([
    { ...profile('first'), label: 'First model' },
    { ...profile('second'), label: 'Second model' },
  ]);
  const names = [...f.container.querySelectorAll<HTMLInputElement>('fieldset input[required]')];
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
  expect(meeting?.participants.map((item) => item.name)).toEqual([
    'Second model',
    'Partner',
    'First model',
  ]);
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

it('says why Create is off beside it, outside the part that scrolls', async () => {
  const f = await mount(null);
  const beside = (text: string) => {
    const said = [...f.container.querySelectorAll('[role="status"], [role="alert"]')].find((item) =>
      item.textContent?.includes(text),
    );
    return Boolean(said) && !said?.closest('[data-scrolls]');
  };
  expect(beside('modelsLoading')).toBe(true);
  state.profiles = [profile('offline', false)];
  await f.render();
  expect(beside('noConnectedModels')).toBe(true);
  state.profiles = [profile('ready'), profile('offline', false)];
  await f.render();
  const pick = async (label: string) => {
    const model = f.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    await act(async () => {
      model.value = 'offline';
      model.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  await pick('participantModel2');
  await pick('secretaryModel');
  expect(beside('unavailableParticipants')).toBe(true);
  expect(beside('secretaryUnavailable')).toBe(true);
  expect(f.button('removeUnavailable')?.closest('[data-scrolls]')).toBeNull();
  expect(f.button('create')?.disabled).toBe(true);
});

it('uses readable numbered participant names for simulated models', async () => {
  const f = await mount(null, false);
  const meeting = await submit(f);
  expect(meeting?.participants.map((item) => item.name)).toEqual([
    'participantDefault1',
    'participantDefault2',
    'participantDefault3',
  ]);
  expect(meeting?.participants.every((item) => item.prompt === '')).toBe(true);
});

it('does not use an internal profile ID as a participant display name', async () => {
  const f = await mount([profile('internal_profile_id')]);
  expect((await submit(f))?.participants.map((item) => item.name)).toEqual([
    'participantDefault1',
    'participantDefault2',
    'participantDefault3',
  ]);
});
