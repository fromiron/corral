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

it('[TC-ULTRA-004-H] new Ultra requests are tournaments with candidates, refinement, auto-apply and the no-limits notice', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  // A draft saved with the earlier opt-in comparison keeps its pool and candidates.
  let value = {
    version: 1,
    modelProfiles: ['primary', 'reviewer'],
    verifierProfile: 'reviewer',
    comparison: { modelProfiles: ['primary', 'reviewer', 'primary'] },
  } as UltraSelection;
  const tournament = () => value as Extract<UltraSelection, { version: 2 }>;
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
  const select = (label: string) =>
    container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const choose = async (label: string, option: string) =>
    act(async () => {
      select(label).value = option;
      select(label).dispatchEvent(new Event('change', { bubbles: true }));
    });
  expect(container.querySelector('input[aria-label="ultraCompareCandidates"]')).toBeNull();
  expect(container.textContent).toContain('ultraNoLimits');
  expect(select('ultraCandidateCount').value).toBe('3');
  await choose('ultraCandidateCount', '5');
  expect(value).toMatchObject({ version: 2, modelProfiles: ['primary', 'reviewer'] });
  expect(tournament().candidates).toHaveLength(5);
  expect(select('ultraRefinementRounds').value).toBe('2');
  await choose('ultraRefinementRounds', '0');
  expect(tournament().refinementRounds).toBe(0);
  const autoApply = container.querySelector<HTMLInputElement>(
    'input[aria-label="ultraAutoApply"]',
  )!;
  expect(autoApply.checked).toBe(true);
  await act(async () => autoApply.click());
  expect(tournament().autoApply).toBe(false);
  expect(value.verifierProfile).toBe('reviewer');
});
