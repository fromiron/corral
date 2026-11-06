// @vitest-environment jsdom
import type { ModelConfig } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ModelConfigEditor } from './ModelConfigEditor.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../workbench/modelSettings.tsx', () => ({
  useModelSettingsRefresh: () => async () => {},
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => async (task: () => Promise<void>) => task(),
}));

it('previews a new endpoint only after its draft is valid, then resumes after further edits', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const previewConfig = vi.fn(
    async (
      _change: Pick<ModelConfig, 'modelProfiles' | 'modelProviders' | 'revision'>,
      _signal?: AbortSignal,
    ) => ({ effectiveProfiles: {} }),
  );
  fixture.services = { models: { previewConfig } };
  const config: ModelConfig = {
    revision: 'revision',
    usingDefaults: false,
    modelProfiles: [],
    modelProviders: [],
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const edit = async (label: string, value: string) => {
    const field = [
      ...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea'),
    ].find(
      (input) =>
        input.getAttribute('aria-label') === label ||
        input.closest('label')?.querySelector('span')?.textContent === label,
    );
    if (!field) throw new Error(`Missing field: ${label}`);
    await act(async () => {
      const prototype =
        field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setValue) throw new Error('Missing native input setter');
      setValue.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const previewAfterPause = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(201);
    });
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ModelConfigEditor config={config} catalog={[]} onDone={() => {}} />
        </IntlProvider>,
      ),
    );
    const addEndpoint = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Add endpoint',
    );
    if (!addEndpoint) throw new Error('Missing Add endpoint action');
    await act(async () => addEndpoint.click());
    await edit('Endpoint id 1', 'local');
    await edit('Address of endpoint 1', 'http://127.0.0.1:11434/v1');
    await previewAfterPause();
    expect(previewConfig).not.toHaveBeenCalled();
    await edit('Models of endpoint 1', 'llama3.2');
    await previewAfterPause();
    expect(previewConfig).toHaveBeenCalledExactlyOnceWith(
      {
        revision: 'revision',
        modelProfiles: [],
        modelProviders: [
          {
            id: 'local',
            name: 'local',
            baseUrl: 'http://127.0.0.1:11434/v1',
            access: 'none',
            models: [{ id: 'llama3.2' }],
          },
        ],
      },
      expect.any(AbortSignal),
    );
    await edit('Address of endpoint 1', 'http://');
    await previewAfterPause();
    expect(previewConfig).toHaveBeenCalledTimes(1);
    await edit('Address of endpoint 1', 'http://localhost:11434/v1');
    await previewAfterPause();
    expect(previewConfig).toHaveBeenCalledTimes(2);
    expect(previewConfig.mock.calls.at(-1)?.[0]).toMatchObject({
      modelProviders: [{ baseUrl: 'http://localhost:11434/v1' }],
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
