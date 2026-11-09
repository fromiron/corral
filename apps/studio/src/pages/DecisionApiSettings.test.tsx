// @vitest-environment jsdom
import type { DecisionApiView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DecisionApiSettings } from './DecisionApiSettings.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));

const KEY = 'decision-secret-key-0123456789';
const apis = (openaiKey: boolean): DecisionApiView[] => [
  { id: 'jev', provider: 'TypeSafe', model: 'jev-latest', keyConfigured: false },
  { id: 'openai-decisions', provider: 'OpenAI', model: 'gpt-6-luna', keyConfigured: openaiKey },
];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function render(onChanged = () => {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <DecisionApiSettings onChanged={onChanged} />
      </IntlProvider>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}
const row = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-decision-api]')].find(
    (node) => node.dataset.decisionApi === name,
  );
const button = (scope: HTMLElement | undefined, name: string) =>
  [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.textContent === name);

it('lists each decision API with its model, key state and documented data handling', async () => {
  fixture.services = { models: { decisionApis: vi.fn().mockResolvedValue(apis(false)) } };
  const container = await render();
  const jev = row(container, 'jev');
  const openai = row(container, 'openai-decisions');
  expect(jev?.textContent).toContain('TypeSafe Jev');
  expect(jev?.textContent).toContain('jev-latest');
  expect(jev?.textContent).toContain('publishes no retention policy');
  expect(openai?.textContent).toContain('OpenAI Decisions');
  expect(openai?.textContent).toContain('gpt-6-luna');
  expect(openai?.textContent).toContain('not used for training');
  expect(openai?.textContent).toContain('OpenAI platform API key');
  expect(openai?.querySelector('[role="status"]')?.textContent).toBe('No key');
});

it('saves a key once, shows only that one is stored, and removes it', async () => {
  const setDecisionApiKey = vi.fn().mockResolvedValue(apis(true));
  const deleteDecisionApiKey = vi.fn().mockResolvedValue(apis(false));
  fixture.services = {
    models: {
      decisionApis: vi.fn().mockResolvedValue(apis(false)),
      setDecisionApiKey,
      deleteDecisionApiKey,
    },
  };
  const onChanged = vi.fn();
  const container = await render(onChanged);
  const openai = row(container, 'openai-decisions');
  const input = openai?.querySelector<HTMLInputElement>('input[type="password"]');
  expect(input).toBeTruthy();
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, KEY);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button(openai, 'Save key')?.click());
  expect(setDecisionApiKey).toHaveBeenCalledWith('openai-decisions', KEY);
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(row(container, 'openai-decisions')?.querySelector('[role="status"]')?.textContent).toBe(
    'Key saved',
  );
  expect(container.innerHTML).not.toContain(KEY);

  await act(async () => button(row(container, 'openai-decisions'), 'Remove key')?.click());
  expect(deleteDecisionApiKey).toHaveBeenCalledWith('openai-decisions');
  expect(onChanged).toHaveBeenCalledTimes(2);
  expect(
    row(container, 'openai-decisions')?.querySelector<HTMLInputElement>('input[type="password"]')
      ?.value,
  ).toBe('');
});

it('says so when the key cannot be saved, and when the list cannot load', async () => {
  fixture.services = {
    models: {
      decisionApis: vi.fn().mockResolvedValue(apis(false)),
      setDecisionApiKey: vi.fn().mockRejectedValue(new Error('403')),
    },
  };
  const container = await render();
  const jev = row(container, 'jev');
  const input = jev?.querySelector<HTMLInputElement>('input[type="password"]');
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, KEY);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button(jev, 'Save key')?.click());
  expect(row(container, 'jev')?.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not save the key',
  );

  fixture.services = { models: { decisionApis: vi.fn().mockRejectedValue(new Error('offline')) } };
  const broken = await render();
  expect(broken.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not load decision APIs',
  );
});
