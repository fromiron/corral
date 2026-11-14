import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { ActivityBar, type ActivityBarControls } from '../src/components/ActivityBar.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

// features/composer-flow.md "활동 바": the open panel's control row is named Reins, the name
// stands at its left end with its explanation icon (features/term-hints.md), and the buttons stay.

function show(controls: ActivityBarControls, locale: 'en' | 'ko' = 'en') {
  return render(
    <IntlProvider locale={locale} messages={locale === 'en' ? en : ko} timeZone="UTC">
      <ActivityBar
        line={{ glyph: 'running', tone: 'active', text: 'Writer works' }}
        controls={controls}
        open
      />
    </IntlProvider>,
  );
}

it.each(['en', 'ko'] as const)(
  'names the control row Reins and shows the name once, with its explanation icon (%s)',
  (locale) => {
    const messages = locale === 'en' ? en : ko;
    show(
      {
        paused: false,
        onPause: vi.fn(),
        onStop: vi.fn(),
        note: <span className="sr-only">For the latest request</span>,
      },
      locale,
    );
    const row = screen.getByRole('region', { name: 'Reins' });
    expect(row).toHaveAccessibleName(messages.Terms.reins.name);
    expect(row).not.toHaveAttribute('aria-label');
    // The name is on screen once, in the row.
    expect(screen.getAllByText('Reins', { exact: true })).toHaveLength(1);
    const icon = within(row).getByRole('button', {
      name: messages.Terms.about.replace('{term}', 'Reins'),
    });
    expect(icon).toHaveAccessibleDescription(messages.Terms.reins.meaning);
    expect(icon).toHaveAttribute('data-term-hint', 'reins');
    // The name comes first, then its icon, then the buttons; the note stays in the row.
    const order = [...row.querySelectorAll('button, [data-reins-name]')].map(
      (node) =>
        node.getAttribute('data-reins-name') ??
        node.getAttribute('data-term-hint') ??
        node.textContent,
    );
    expect(order).toEqual(['', 'reins', messages.Activity.pause, messages.Activity.stop]);
    expect(within(row).getByText('For the latest request')).toBeInTheDocument();
  },
);

it('keeps Pause and Stop working beside the name', async () => {
  const user = userEvent.setup();
  const onPause = vi.fn();
  const onStop = vi.fn();
  show({ paused: false, onPause, onStop });
  const row = screen.getByRole('region', { name: 'Reins' });
  await user.click(within(row).getByRole('button', { name: en.Activity.pause }));
  await user.click(within(row).getByRole('button', { name: en.Activity.stop }));
  expect(onPause).toHaveBeenCalledOnce();
  expect(onStop).toHaveBeenCalledOnce();
});

it('names a meeting’s row, with Stop only, Reins too', async () => {
  const user = userEvent.setup();
  const onStop = vi.fn();
  show({ paused: false, onStop });
  const row = screen.getByRole('region', { name: 'Reins' });
  expect(
    within(row)
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-term-hint') ?? b.textContent),
  ).toEqual(['reins', en.Activity.stop]);
  await user.click(within(row).getByRole('button', { name: en.Activity.stop }));
  expect(onStop).toHaveBeenCalledOnce();
});
