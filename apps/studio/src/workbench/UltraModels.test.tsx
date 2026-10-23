// @vitest-environment jsdom

import type { UltraSelection } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { UltraModels } from './UltraModels.tsx';

const translate = vi.hoisted(() => (key: string) => key);
vi.mock('use-intl', () => ({ useTranslations: () => translate }));
vi.mock('@corral/react/ui', () => ({
  Select: ({ label, value, options, onValueChange, disabled }: any) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option: any) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

it('[TC-ULTRA-002-H] comparison is opt-in, keeps the model pool, and assigns three explicit candidates', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let value: UltraSelection = {
    version: 1,
    modelProfiles: ['primary', 'reviewer'],
    verifierProfile: 'reviewer',
  };
  const render = () =>
    root.render(
      <UltraModels
        primary="primary"
        profiles={null}
        value={value}
        disabled={false}
        onChange={(next) => {
          value = next;
          render();
        }}
      />,
    );
  await act(async () => render());
  expect(value.comparison).toBeUndefined();
  const toggle = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="ultraCompareCandidates"]');
  expect(toggle()).not.toBeNull();
  await act(async () => toggle()?.click());
  expect(value.comparison?.modelProfiles).toEqual(['primary', 'reviewer', 'primary']);
  expect(value.modelProfiles).toEqual(['primary', 'reviewer']);
  const count = container.querySelector<HTMLSelectElement>(
    'select[aria-label="ultraCandidateCount"]',
  );
  expect(count).not.toBeNull();
  await act(async () => {
    if (count) {
      count.value = '5';
      count.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  expect(value.comparison?.modelProfiles).toHaveLength(5);
  expect([...(count?.options ?? [])].map((option) => option.value)).toEqual(['2', '3', '4', '5']);
  await act(async () => toggle()?.click());
  expect(value.comparison).toBeUndefined();
  expect(value.verifierProfile).toBe('reviewer');
});
