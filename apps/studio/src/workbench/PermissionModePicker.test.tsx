// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { PermissionModePicker } from './PermissionModePicker.tsx';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function picker(value: Parameters<typeof PermissionModePicker>[0]['value']) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <PermissionModePicker value={value} onChange={() => {}} />
      </IntlProvider>,
    ),
  );
  const chip = container.querySelector<HTMLElement>('[role="combobox"]');
  if (!chip) throw new Error('no permission chip');
  return chip;
}

// features/composer-flow.md "화면 틀": only the default policy may give its name up for a mark on
// a narrow composer; a policy the person chose keeps its name at every width.
it('the default policy carries the mark it folds to, and says its name and value where it is pointed at', async () => {
  const chip = await picker(undefined);
  expect(chip.getAttribute('aria-label')).toBe('Permissions for next request');
  expect(chip.textContent).toContain('Default policy');
  expect(chip.querySelector('[data-policy-mark]')).not.toBeNull();
  expect(chip.hasAttribute('data-folds')).toBe(true);
});

it.each(['ask', 'accept_edits', 'auto'] as const)(
  'a chosen policy (%s) has no mark to fold to',
  async (mode) => {
    const chip = await picker(mode);
    expect(chip.querySelector('[data-policy-mark]')).toBeNull();
    expect(chip.hasAttribute('data-folds')).toBe(false);
    expect(chip.textContent).toContain(messages.Composer.permissionMode[mode]);
  },
);
