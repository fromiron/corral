// @vitest-environment jsdom
import {
  ApiError,
  type ModelConfig,
  type ModelProfileView,
  type ModelsApi,
  type ProfileConfig,
} from '@corral/client';
import { SCHEMA_VERSION } from '@corral/contracts';
import { parseWorkspaceConfig } from '@corral/core';
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
/** Profiles as the server sends them: parsed by the config schema, so in its field order. */
function fromServer(list: object[]): ProfileConfig[] {
  const parsed = parseWorkspaceConfig({ schemaVersion: SCHEMA_VERSION, modelProfiles: list });
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.config.modelProfiles ?? [];
}
const saveBar = () => document.body.querySelector('[data-save-bar]');
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

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

  it('counts a saved profile unchanged in whatever order the server gives its fields', async () => {
    // Written in another order than the schema's; the server answers in the schema's.
    const saved = fromServer([
      {
        compaction: { keepRecentTokens: 20_000, reserveTokens: 8_000 },
        contextWindow: 200_000,
        workerIsolation: 'linux-bwrap',
        model: 'gpt-6-luna',
        provider: 'openai',
        id: 'isolated',
      },
      { cacheRetention: 'long', model: 'o9', provider: 'openai', id: 'cached' },
      { compaction: { reserveTokens: 4_000 }, model: 'o9', provider: 'openai', id: 'compact' },
    ]);
    const start: ModelConfig = { ...config, modelProfiles: saved };
    await show({ config: start });
    expect(saveBar()).toBeNull();

    // After a save, the answer is the saved state: nothing is left unsaved.
    fixture.models.saveConfig = vi.fn(async (change: { modelProfiles: ProfileConfig[] }) => ({
      ...start,
      revision: 'r2',
      modelProfiles: fromServer(change.modelProfiles),
    })) as unknown as ModelsApi['saveConfig'];
    await click(control('Advanced settings of cached'));
    await type(
      all<HTMLInputElement>('[data-profile-id="cached"] [data-field="contextWindow"] input')[0],
      '64000',
    );
    expect(visibleText(saveBar())).toContain('1 unsaved change');
    await click(control('Save'));
    await settle();
    expect(fixture.models.saveConfig).toHaveBeenCalledTimes(1);
    const after = (fixture.models.saveConfig as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as Promise<ModelConfig>;
    const savedConfig = await after;
    await show({ config: savedConfig });
    expect(saveBar()).toBeNull();

    // A newer config with nothing edited here is taken as it comes.
    await show({
      config: {
        ...savedConfig,
        revision: 'r3',
        modelProfiles: [
          ...savedConfig.modelProfiles,
          ...fromServer([{ id: 'newer', provider: 'openai', model: 'o9' }]),
        ],
      },
    });
    expect(all('[data-profile-id]').map((el) => el.getAttribute('data-profile-id'))).toEqual([
      'isolated',
      'cached',
      'compact',
      'newer',
    ]);
    expect(saveBar()).toBeNull();
  });

  it('saves again on the new revision when only the revision moved', async () => {
    fixture.models.saveConfig = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'REVISION_CONFLICT', 'the config changed'))
      .mockImplementation(async (change: { modelProfiles: ProfileConfig[] }) => ({
        ...config,
        revision: 'r3',
        modelProfiles: change.modelProfiles,
      }));
    // Something else saved (effort routing, say): the profiles are as they were.
    fixture.models.config = vi.fn(async () => ({ ...config, revision: 'r2' }));
    await show();
    await click(control('Add profile'));
    await choose(undefined, 'o9');
    await click(control('Save'));
    await settle();
    expect(fixture.models.config).toHaveBeenCalled();
    expect(fixture.models.saveConfig).toHaveBeenCalledTimes(2);
    expect(fixture.models.saveConfig).toHaveBeenLastCalledWith({
      revision: 'r2',
      modelProfiles: [
        { id: 'gpt-6-luna', provider: 'openai', model: 'gpt-6-luna' },
        { id: 'o9', provider: 'openai', model: 'o9' },
      ],
      modelProviders: [],
    });
    expect(document.body.textContent).not.toContain('Profiles changed elsewhere');
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it('says profiles changed elsewhere only when they did, and starts again from the latest', async () => {
    fixture.models.saveConfig = vi
      .fn()
      .mockRejectedValue(new ApiError(409, 'REVISION_CONFLICT', 'the config changed'));
    fixture.models.config = vi.fn(async () => ({
      ...config,
      revision: 'r2',
      modelProfiles: [
        ...config.modelProfiles,
        { id: 'other', provider: 'github-copilot', model: 'claude-opus' },
      ],
    }));
    await show();
    await click(control('Add profile'));
    await choose(undefined, 'o9');
    await click(control('Save'));
    await settle();
    expect(fixture.models.saveConfig).toHaveBeenCalledTimes(1);
    expect(saveBar()?.querySelector('[role="alert"]')?.textContent).toContain(
      'Profiles changed elsewhere',
    );
    // The edits are still here.
    expect(nameField(2)?.value).toBe('o9');
    // The page has not read the new config yet; starting again uses the one just read.
    await click(control('Start from the latest'));
    expect(all('[data-profile-id]').map((el) => el.getAttribute('data-profile-id'))).toEqual([
      'gpt-6-luna',
      'other',
    ]);
    expect(nameField(2)).toBeUndefined();
    expect(saveBar()).toBeNull();
  });

  it('says why Save is off when a new profile has no name, tied to the name field', async () => {
    await show();
    await click(control('Add profile'));
    await choose(undefined, 'o9');
    await type(nameField(2), '');
    expect((control('Save') as HTMLButtonElement | undefined)?.disabled).toBe(true);
    const described = nameField(2)?.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described ?? '')?.textContent).toBe(
      'Start with a letter, then letters, digits or - _ . :',
    );
  });

  it('drops a preview that no longer describes the draft', async () => {
    let fail = false;
    fixture.models.previewConfig = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return {
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
      };
    }) as unknown as ModelsApi['previewConfig'];
    await show();
    await click(control('Advanced settings of gpt-6-luna'));
    const context = field('Context window');
    const reserve = () => field('Summary reserve');
    await type(context, '200000');
    await advance(250);
    expect(reserve()?.placeholder).toBe('16,384 · model-based default');
    // A value that does not read is not previewed, and the last preview goes with it.
    await type(context, 'abc');
    await advance(250);
    expect(reserve()?.placeholder).toBe('Default');
    expect(reserve()?.closest('[data-field]')?.textContent).not.toContain(
      'below the request output cap',
    );
    await type(context, '200000');
    await advance(250);
    expect(reserve()?.placeholder).toBe('16,384 · model-based default');
    // Nor does a preview that failed leave the one before it in place.
    fail = true;
    await type(context, '300000');
    await advance(250);
    expect(reserve()?.placeholder).toBe('Default');
  });

  it('puts each refusal of a joined answer next to its own profile', async () => {
    fixture.models.saveConfig = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          400,
          'SCHEMA_INVALID',
          'modelProfiles.0.contextWindow: above the model limit; modelProfiles.1: reserve must be below the context window; modelProviders: too many endpoints',
        ),
      );
    await show();
    await click(control('Add profile'));
    await choose(undefined, 'Claude Opus');
    await click(control('Save'));
    await settle();
    const [first, second] = all('[data-profile-row]');
    expect(first?.querySelector('[role="alert"]')?.textContent).toBe(
      'Not saved: above the model limit',
    );
    expect(second?.querySelector('[role="alert"]')?.textContent).toBe(
      'Not saved: reserve must be below the context window',
    );
    expect(saveBar()?.querySelector('[role="alert"]')?.textContent).toBe(
      'modelProviders: too many endpoints',
    );
  });

  it('does not say a save failed when only reading the lists after it failed', async () => {
    fixture.models.saveConfig = vi.fn(async (change: { modelProfiles: ProfileConfig[] }) => ({
      ...config,
      revision: 'r2',
      modelProfiles: change.modelProfiles,
    })) as unknown as ModelsApi['saveConfig'];
    fixture.refresh = vi.fn(async () => {
      throw new Error('offline');
    });
    await show();
    await click(control('Add profile'));
    await choose(undefined, 'o9');
    await click(control('Save'));
    await settle();
    expect(fixture.models.saveConfig).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('Not saved');
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    // The next edit counts as an edit, not as a save that failed.
    await click(control('Add profile'));
    await choose(undefined, 'Claude Opus');
    expect(saveBar()?.querySelector('[role="alert"]')).toBeNull();
    expect(visibleText(saveBar())).toContain('1 unsaved change');
  });

  it('tells the page once it has made the profile a request asked for', async () => {
    const onRequestHandled = vi.fn();
    await show({ request: { provider: 'openai', model: 'o9', nonce: 7 }, onRequestHandled });
    await settle();
    expect(nameField(2)?.value).toBe('o9');
    expect(onRequestHandled).toHaveBeenCalledWith(7);
  });
});
