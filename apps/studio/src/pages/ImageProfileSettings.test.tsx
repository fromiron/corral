// @vitest-environment jsdom
import type { ModelProfileView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ImageProfileSettings } from './ImageProfileSettings.tsx';

// Image generation needs an API key: a subscription sign-in is refused on the profile field
// itself, not explained ahead of the form.

vi.mock('../image-profiles-api.ts', () => ({
  imageProfilesApi: {
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
      ],
      statuses: {},
    })),
  },
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
