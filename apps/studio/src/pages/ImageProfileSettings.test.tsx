// @vitest-environment jsdom
import type { ModelProfileView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ImageProfileSettings } from './ImageProfileSettings.tsx';
import { all, click, control, field, settle, stubBrowser, type } from './modelTestDom.ts';

// Image generation needs an API key: a subscription sign-in is refused on the profile field
// itself, not explained ahead of the form. The profile id is derived, not typed.

const api = vi.hoisted(() => ({
  list: vi.fn(async () => ({
    profiles: [
      {
        profileId: 'from-subscription',
        modelProfileId: 'subscription',
        modelId: 'gpt-image-1',
        api: 'openai-images',
        timeoutMs: 120000,
      },
      {
        profileId: 'from-key',
        modelProfileId: 'keyed',
        modelId: 'gpt-image-1',
        api: 'openai-images',
        timeoutMs: 120000,
      },
      {
        profileId: 'keyed:gpt-image-1',
        modelProfileId: 'keyed',
        modelId: 'gpt-image-1',
        api: 'openai-images',
        timeoutMs: 90000,
      },
    ],
    statuses: {},
  })),
  save: vi.fn(async () => undefined),
}));

vi.mock('../image-profiles-api.ts', () => ({
  imageProfilesApi: api,
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => (action: () => Promise<unknown>) => action(),
}));

const profile = (profileId: string, method: ModelProfileView['method']) =>
  ({ profileId, method, provider: 'openai', modelId: 'gpt-test' }) as ModelProfileView;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function render() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <ImageProfileSettings
          modelProfiles={[profile('subscription', 'oauth'), profile('keyed', 'api_key')]}
        />
      </IntlProvider>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

async function edit(container: HTMLElement, profileId: string) {
  const row = [...container.querySelectorAll('li')].find((item) =>
    item.textContent?.includes(profileId),
  );
  const button = [...(row?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent === messages.ImageProfiles.edit,
  );
  await act(async () => button?.click());
}

it('puts no intro sentence under the heading', async () => {
  const container = await render();
  const heading = container.querySelector('h3');
  expect(heading?.nextElementSibling?.tagName).not.toBe('P');
});

it('refuses a subscription sign-in on the provider profile field', async () => {
  const container = await render();
  await edit(container, 'from-subscription');
  const form = container.querySelector('form');
  expect(form?.textContent).toContain(messages.ImageProfiles.needsApiKey);
});

it('says nothing on the field for a profile that uses an API key', async () => {
  const container = await render();
  await edit(container, 'from-key');
  const form = container.querySelector('form');
  expect(form).toBeTruthy();
  expect(form?.textContent).not.toContain(messages.ImageProfiles.needsApiKey);
});

function shownProfileId(form: ParentNode): string {
  const term = all('dt', form).find((el) => el.textContent === messages.ImageProfiles.id);
  const value = term?.nextElementSibling;
  return value?.tagName === 'DD' ? (value.textContent?.trim() ?? '') : '';
}

async function pickConnection(profileId: string) {
  stubBrowser();
  Element.prototype.getAnimations ??= () => [];
  await click(control(messages.ImageProfiles.providerProfile));
  await settle();
  await click(
    all('[role="option"], [data-value]').find((el) => el.getAttribute('data-value') === profileId),
  );
  await settle();
}

it('derives a read-only image profile id from the connection and the image model', async () => {
  const container = await render();
  await click(control(messages.ImageProfiles.add));
  const form = container.querySelector('form');
  if (!form) throw new Error('the add form did not open');
  expect(form.querySelector('input[id$="-id"]')).toBeNull();
  expect(shownProfileId(form)).toBe(messages.ImageProfiles.idPending);
  // The id changes with each keystroke; it is read where it stands, not announced.
  expect(form.querySelector('output, [aria-live], [role="status"], [role="alert"]')).toBeNull();

  await pickConnection('keyed');
  await type(field(messages.ImageProfiles.model, form), 'gpt-image-2');
  expect(shownProfileId(form)).toBe('keyed:gpt-image-2');

  await type(field(messages.ImageProfiles.model, form), 'gpt-image-1');
  // keyed:gpt-image-1 is already saved, so the new profile takes the next number.
  expect(shownProfileId(form)).toBe('keyed:gpt-image-1-2');

  await type(field(messages.ImageProfiles.model, form), 'vendor/name');
  const slashed = shownProfileId(form);
  await type(field(messages.ImageProfiles.model, form), 'vendor_name');
  const underscored = shownProfileId(form);
  expect(underscored).toBe('keyed:vendor_name');
  expect(slashed).not.toBe(underscored);
  expect(slashed).not.toContain('/');
  expect(form.querySelector('input[id$="-id"]')).toBeNull();
});

it('keeps a saved profile id that the derivation would not produce', async () => {
  const container = await render();
  await edit(container, 'from-key');
  const form = container.querySelector('form');
  if (!form) throw new Error('the edit form did not open');
  expect(shownProfileId(form)).toBe('from-key');
  await type(field(messages.ImageProfiles.model, form), 'other-model');
  expect(shownProfileId(form)).toBe('from-key');
  await click(control(messages.ImageProfiles.save, form));
  await settle();
  expect(api.save).toHaveBeenCalledWith(
    expect.objectContaining({
      profileId: 'from-key',
      modelId: 'other-model',
      modelProfileId: 'keyed',
    }),
  );
});

it('keeps the image model id as an input and does not offer a reasoning field', async () => {
  const container = await render();
  await click(control(messages.ImageProfiles.add));
  const form = container.querySelector('form');
  if (!form) throw new Error('the add form did not open');
  expect(field(messages.ImageProfiles.model, form)).toBeTruthy();
  expect(form.textContent).toContain(messages.ImageProfiles.modelHint);
  expect(container.textContent).toContain(messages.ImageProfiles.reasoningNote);
  expect(all('[role="combobox"]', form).map((el) => el.getAttribute('aria-label'))).toEqual([
    messages.ImageProfiles.providerProfile,
  ]);
});
