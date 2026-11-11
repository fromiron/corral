// @vitest-environment jsdom
import { createEditorStore } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { MarkdownAgentImport } from './MarkdownAgentImport.tsx';

vi.mock('../services.tsx', () => ({ useServices: () => ({ harnesses: {} }) }));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

it('opens from a compact button, the same size as the editor head controls beside it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <MarkdownAgentImport editor={createEditorStore()} profiles={[]} projectId="default" />
      </IntlProvider>,
    ),
  );
  const trigger = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Import Markdown agent',
  );
  // Export JSON, Test run and Save in the head are all compact buttons.
  expect(trigger?.dataset.size).toBe('compact');
});

it('chooses the connected model with the searchable model field', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const profiles = [
    {
      profileId: 'openai:gpt-6',
      source: 'connection' as const,
      provider: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-6',
      modelName: 'GPT-6',
      label: 'OpenAI · GPT-6',
      available: true,
    },
  ];
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <MarkdownAgentImport editor={createEditorStore()} profiles={profiles} projectId="default" />
      </IntlProvider>,
    ),
  );
  const open = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Import Markdown agent',
  );
  await act(async () => open?.click());
  const field = () =>
    document.querySelector<HTMLButtonElement>(
      '[data-slot="model-picker-trigger"][aria-label^="Connected model profile"]',
    );
  expect(field()?.getAttribute('aria-label')).toBe(
    'Connected model profile: Map to a connected model',
  );
  await act(async () => field()?.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (el) => el.getAttribute('aria-label') === 'GPT-6',
  );
  expect(option?.closest('[role="group"]')?.getAttribute('aria-label')).toBe('OpenAI');
  await act(async () => option?.click());
  expect(field()?.getAttribute('aria-label')).toBe('Connected model profile: GPT-6');
});
