// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsPatchPanel } from '../src/components/SettingsPatchPanel.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { advisorNodeId, advisorRunSession } from '../src/stories/advisorRunFixture.ts';

// The kit's select as a native one, so its options can be read and chosen here.
vi.mock('../src/design-kit/index.ts', async (original) => ({
  ...(await original<typeof import('../src/design-kit/index.ts')>()),
  Select: ({
    value,
    label,
    options,
    onValueChange,
  }: {
    value: string;
    label: string;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

afterEach(cleanup);

// A conversation's own Outrider has no name of its own: the settings change's node choice calls
// it by the one word, never by the name stored for the model (features/advisor.md, 보이는 곳).
it.each(['en', 'ko'] as const)(
  'names the conversation’s Outrider by the one word among the nodes a change can target (%s)',
  async (locale) => {
    const text = locale === 'ko' ? ko : en;
    render(
      <IntlProvider locale={locale} messages={locale === 'ko' ? ko : en} timeZone="UTC">
        <SettingsPatchPanel session={advisorRunSession({ session: true })} />
      </IntlProvider>,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: text.SettingsPatch.heading })),
    );
    const scope = screen.getByRole('combobox', { name: text.SettingsPatch.scope });
    await act(async () => fireEvent.change(scope, { target: { value: 'node_future' } }));
    const node = screen.getByRole('combobox', { name: text.SettingsPatch.node });
    const options = [...node.querySelectorAll('option')];
    const outrider = options.find((option) => option.value === advisorNodeId({ session: true }));
    expect(outrider?.textContent).toBe(`Outrider · ${advisorNodeId({ session: true })}`);
    expect(options.map((option) => option.textContent).join('\n')).not.toContain('Advisor');
  },
);
