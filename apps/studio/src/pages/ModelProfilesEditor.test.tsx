// @vitest-environment jsdom
import { ApiError, type ModelConfig, type ModelProfileView, type ModelsApi } from '@corral/client';
import { DesignKitProvider } from '@corral/react/design-kit';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ModelProfilesEditor } from './ModelProfilesEditor.tsx';
import {
  all,
  click,
  control,
  field,
  settle,
  stubBrowser,
  type,
  visibleText,
} from './modelTestDom.ts';

const fixture = vi.hoisted(() => ({ models: {} as Partial<ModelsApi>, refresh: vi.fn() }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', live: true, models: fixture.models }),
}));
vi.mock('../workbench/modelSettings.tsx', () => ({
  useModelSettingsRefresh: () => fixture.refresh,
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => async () => true,
  useSettingsTask: () => async (task: () => Promise<unknown>) => task(),
}));

const view = (patch: Partial<ModelProfileView>): ModelProfileView => ({
  profileId: `${patch.provider ?? 'openai'}:${patch.modelId}`,
  source: 'connection',
  provider: 'openai',
  providerName: 'OpenAI',
  modelId: 'gpt-6',
  modelName: null,
  available: true,
  reasoning: false,
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  method: 'oauth',
  keyConfigured: true,
  subscriptionSupported: null,
  ...patch,
});

const config: ModelConfig = {
  revision: 'r1',
  usingDefaults: false,
  modelProfiles: [{ id: 'gpt-6-luna', provider: 'openai', model: 'gpt-6-luna' }],
  modelProviders: [],
};
const profiles: ModelProfileView[] = [
  view({
    profileId: 'gpt-6-luna',
    source: 'profile',
    modelId: 'gpt-6-luna',
    modelName: 'GPT-6 Luna',
  }),
  view({ modelId: 'o9', modelName: 'o9' }),
  view({
    provider: 'github-copilot',
    providerName: 'GitHub Copilot',
    modelId: 'claude-opus',
    modelName: 'Claude Opus',
  }),
];

let root: Root;
let container: HTMLElement;
async function show(patch: Partial<Parameters<typeof ModelProfilesEditor>[0]> = {}) {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <DesignKitProvider>
          <ModelProfilesEditor config={config} profiles={profiles} {...patch} />
        </DesignKitProvider>
      </IntlProvider>,
    ),
  );
}
const nameField = (n: number) => field(`Name of profile ${n}`);
const modelButton = (profile: string) =>
  all('button').find((el) => el.getAttribute('aria-label')?.startsWith(`Model of ${profile}:`));
async function choose(trigger: Element | undefined, option: string) {
  if (trigger) await click(trigger);
  await settle();
  await click(all('[role="option"]').find((el) => el.getAttribute('aria-label') === option));
  await settle();
}

beforeEach(() => {
  stubBrowser();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fixture.refresh = vi.fn(async () => {});
  fixture.models = {
    previewConfig: vi.fn(async () => ({ revision: 'r1', effectiveProfiles: {} })),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Profiles tab', () => {
  it('names a new profile after its model and follows the model until the name is edited', async () => {
    await show();
    // Adding opens the model picker first.
    await click(control('Add profile'));
    await settle();
    expect(document.body.querySelector('[role="combobox"]')).not.toBeNull();
    // The models a profile can point at, by provider; the named profile's model is one of them.
    expect(
      all('[role="listbox"] [role="group"]').map((group) => group.getAttribute('aria-label')),
    ).toEqual(['GitHub Copilot', 'OpenAI']);
    await choose(undefined, 'GPT-6 Luna');
    // The model id, numbered because another profile has that name.
    expect(nameField(2)?.value).toBe('gpt-6-luna-2');
    await choose(modelButton('gpt-6-luna-2'), 'o9');
    expect(nameField(2)?.value).toBe('o9');
    // A name typed by hand stays when the model changes.
    await type(nameField(2), 'fast');
    await choose(modelButton('fast'), 'Claude Opus');
    expect(nameField(2)?.value).toBe('fast');
    // A saved profile's name is not renamed under the teams and sessions that use it.
    expect(nameField(1)).toBeUndefined();
  });

  it('shows Save and Cancel only while something changed', async () => {
    await show();
    // The tab already names the list: no heading repeats it, and the list keeps its name.
    expect(document.body.querySelector('h3')).toBeNull();
    expect(document.body.querySelector('section[aria-label="Profiles"]')).not.toBeNull();
    expect(control('Save')).toBeUndefined();
    expect(control('Cancel')).toBeUndefined();
    await click(control('Add profile'));
    await choose(undefined, 'o9');
    expect(control('Save')).toBeDefined();
    expect(visibleText(control('Save')?.closest('[data-save-bar]'))).toContain('1 unsaved change');
    await click(control('Cancel'));
    expect(nameField(2)).toBeUndefined();
    expect(control('Save')).toBeUndefined();
    // Closing the picker without a model adds nothing.
    await click(control('Add profile'));
    await settle();
    await act(async () => {
      document.body
        .querySelector('[role="combobox"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(400);
    expect(nameField(2)).toBeUndefined();
    expect(control('Save')).toBeUndefined();
  });

  it('saves the profiles and says a refusal next to the profile that caused it', async () => {
    fixture.models.saveConfig = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          400,
          'SCHEMA_INVALID',
          'modelProfiles.1: reserve must be below the context window',
        ),
      )
      .mockResolvedValue({ ...config, revision: 'r2' });
    await show();
    await click(control('Add profile'));
    await choose(undefined, 'Claude Opus');
    await click(control('Save'));
    await settle();
    expect(fixture.models.saveConfig).toHaveBeenCalledWith({
      revision: 'r1',
      modelProfiles: [
        { id: 'gpt-6-luna', provider: 'openai', model: 'gpt-6-luna' },
        { id: 'claude-opus', provider: 'github-copilot', model: 'claude-opus' },
      ],
      modelProviders: [],
    });
    const second = all('[data-profile-row]')[1];
    expect(second?.querySelector('[role="alert"]')?.textContent).toContain(
      'reserve must be below the context window',
    );
    await click(control('Save'));
    await settle();
    expect(fixture.refresh).toHaveBeenCalled();
    expect(control('Save')).toBeUndefined();
  });

  it("says a refusal that names no profile in the server's words", async () => {
    fixture.models.saveConfig = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, 'CAPABILITY_DENIED', 'the GitHub Copilot model list is not loaded yet'),
      );
    await show();
    await click(control('Add profile'));
    await choose(undefined, 'Claude Opus');
    await click(control('Save'));
    await settle();
    expect(document.body.querySelector('[data-save-bar] [role="alert"]')?.textContent).toBe(
      'the GitHub Copilot model list is not loaded yet',
    );
    // Nothing is lost: the edit is still there to save again.
    expect(control('Save')).toBeDefined();
  });

  it('previews effective values only for a valid draft and shows them as placeholders', async () => {
    fixture.models.previewConfig = vi.fn(async () => ({
      revision: 'r1',
      effectiveProfiles: {
        'gpt-6-luna': {
          policy: {
            version: 2,
            contextWindow: 200_000,
            reserveTokens: 16_384,
            keepRecentTokens: 20_000,
            sources: {
              contextWindow: 'profile',
              reserveTokens: 'adaptive',
              keepRecentTokens: 'adaptive',
            },
            baseContextWindow: 400_000,
            baseSource: 'catalog',
            warnings: ['reserve_below_output'],
            configRevision: 'r1',
          },
          errors: [],
        },
      },
    })) as unknown as ModelsApi['previewConfig'];
    await show();
    await click(control('Advanced settings of gpt-6-luna'));
    const context = field('Context window');
    await type(context, 'abc');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fixture.models.previewConfig).not.toHaveBeenCalled();
    expect(context?.closest('[data-field]')?.textContent).toContain(
      'A whole number from 1 to 10,000,000',
    );
    await type(context, '200000');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fixture.models.previewConfig).toHaveBeenCalledWith(
      {
        revision: 'r1',
        modelProfiles: [
          { id: 'gpt-6-luna', provider: 'openai', model: 'gpt-6-luna', contextWindow: 200_000 },
        ],
        modelProviders: [],
      },
      expect.any(AbortSignal),
    );
    expect(field('Summary reserve')?.placeholder).toBe('16,384 · model-based default');
    // A warning shows under the value it is about, and only while it applies.
    expect(field('Summary reserve')?.closest('[data-field]')?.textContent).toContain(
      'Summary reserve is below the request output cap',
    );
    expect(field('Recent history')?.closest('[data-field]')?.textContent).not.toContain(
      'below the request output cap',
    );
    // No always-on paragraphs: no revision, no "Base limit" line.
    expect(document.body.textContent).not.toMatch(/Config revision|Base limit|Blank uses/);
  });
});
