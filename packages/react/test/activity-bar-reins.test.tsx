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

// features/composer-flow.md "활동 바": with the bar open and its line saying nothing, the Reins
// controls stand on the line itself (the name where the mark was, the controls before the
// overview and the toggle) and the panel keeps no separate row for them; a line that says
// something keeps them as the panel's last row.

const QUIET = { glyph: 'running', tone: 'active' } as const;
const SPEAKING = { glyph: 'running', tone: 'active', text: 'Writer works' } as const;

function Bar({
  line,
  controls,
  open = true,
  roles = true,
}: {
  line: Parameters<typeof ActivityBar>[0]['line'];
  controls?: ActivityBarControls;
  open?: boolean;
  roles?: boolean;
}) {
  return (
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <ActivityBar
        line={line}
        end={<button type="button">Overview</button>}
        roles={
          roles
            ? [
                {
                  id: 'exec_writer',
                  name: 'Writer',
                  glyph: 'running',
                  tone: 'active',
                  stateShown: true,
                  working: true,
                  target: true,
                },
              ]
            : []
        }
        {...(controls ? { controls } : {})}
        open={open}
      />
    </IntlProvider>
  );
}

const lineRow = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-activity-bar] > div');
const detailsPanel = () => screen.getByRole('region', { name: en.Activity.details });
const reins = () => screen.getByRole('region', { name: en.Terms.reins.name });

it('puts the Reins controls on a line that says nothing, with no row of their own', () => {
  const { container } = render(
    <Bar line={QUIET} controls={{ paused: false, onPause: vi.fn(), onStop: vi.fn() }} />,
  );
  const row = lineRow(container);
  const group = reins();
  expect(row?.contains(group)).toBe(true);
  expect(detailsPanel().contains(group)).toBe(false);
  expect(screen.getAllByRole('region', { name: en.Terms.reins.name })).toHaveLength(1);
  // The name and its explanation where the mark was: no mark is drawn.
  expect(within(group).getByText(en.Terms.reins.name, { exact: true })).toHaveAttribute(
    'data-reins-name',
  );
  expect(
    within(group).getByRole('button', { name: en.Terms.about.replace('{term}', 'Reins') }),
  ).toBeInTheDocument();
  // Every icon on the row belongs to a button: the state's mark is not there.
  expect([...(row?.querySelectorAll('svg') ?? [])].every((svg) => svg.closest('button'))).toBe(
    true,
  );
  // The controls, then the overview and the toggle, in that order on the one row.
  const order = [...(row?.querySelectorAll('button') ?? [])].map(
    (button) =>
      button.getAttribute('data-term-hint') ??
      (button.hasAttribute('data-activity-toggle') ? 'toggle' : button.textContent),
  );
  expect(order).toEqual(['reins', en.Activity.pause, en.Activity.stop, 'Overview', 'toggle']);
  // The line keeps its one height.
  expect(row?.className).toContain('h-8');
});

it('keeps the Reins controls as the panel’s last row while the line says something', () => {
  const { container } = render(
    <Bar line={SPEAKING} controls={{ paused: false, onPause: vi.fn(), onStop: vi.fn() }} />,
  );
  const group = reins();
  expect(detailsPanel().contains(group)).toBe(true);
  expect(lineRow(container)?.contains(group)).toBe(false);
  expect(lineRow(container)?.textContent).toContain('Writer works');
  expect(detailsPanel().lastElementChild).toBe(group);
});

it.each([
  ['state words', { state: { text: 'Working', target: 'run:run_1' as const } }],
  ['parts', { parts: <span>1/3 done</span> }],
  ['a clock', { startedAt: 1 }],
  ['an action', { action: { label: 'View' } }],
  ['a warning', { warning: true }],
])('counts a line with %s as saying something', (_, extra) => {
  render(<Bar line={{ ...QUIET, ...extra }} controls={{ paused: false, onPause: vi.fn() }} />);
  expect(detailsPanel().contains(reins())).toBe(true);
});

it('draws no controls while the bar is closed', () => {
  render(
    <Bar
      line={QUIET}
      controls={{ paused: false, onPause: vi.fn(), onStop: vi.fn() }}
      open={false}
    />,
  );
  expect(screen.queryByRole('region', { name: en.Terms.reins.name })).toBeNull();
  expect(screen.queryByRole('button', { name: en.Activity.pause })).toBeNull();
});

it.each([
  ['on the line', QUIET],
  ['in the panel', SPEAKING],
] as const)('offers Stop %s only when it is given', (_, line) => {
  const { rerender } = render(<Bar line={line} controls={{ paused: false, onPause: vi.fn() }} />);
  expect(within(reins()).queryByRole('button', { name: en.Activity.stop })).toBeNull();
  expect(within(reins()).getByRole('button', { name: en.Activity.pause })).toBeInTheDocument();
  rerender(<Bar line={line} controls={{ paused: false, onPause: vi.fn(), onStop: vi.fn() }} />);
  expect(within(reins()).getByRole('button', { name: en.Activity.stop })).toBeInTheDocument();
});

it('leaves no empty panel when the controls were all it had', () => {
  render(<Bar line={QUIET} controls={{ paused: false, onPause: vi.fn() }} roles={false} />);
  expect(reins()).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: en.Activity.details })).toBeNull();
});

it.each([
  ['from the line to the panel', QUIET, SPEAKING],
  ['from the panel to the line', SPEAKING, QUIET],
] as const)('keeps the focus on the same control when it moves %s', (_, before, after) => {
  const controls = { paused: false, onPause: vi.fn(), onStop: vi.fn() };
  const { rerender } = render(<Bar line={before} controls={controls} />);
  for (const name of [en.Activity.pause, en.Activity.stop]) {
    rerender(<Bar line={before} controls={controls} />);
    within(reins()).getByRole('button', { name }).focus();
    rerender(<Bar line={after} controls={controls} />);
    const moved = within(reins()).getByRole('button', { name });
    expect(document.activeElement).toBe(moved);
    // And back again.
    rerender(<Bar line={before} controls={controls} />);
    expect(document.activeElement).toBe(within(reins()).getByRole('button', { name }));
  }
});

it('gives the focus to the toggle when the controls it was on fold away', () => {
  const controls = { paused: false, onPause: vi.fn() };
  const { container, rerender } = render(<Bar line={QUIET} controls={controls} />);
  within(reins()).getByRole('button', { name: en.Activity.pause }).focus();
  rerender(<Bar line={QUIET} controls={controls} open={false} />);
  expect(document.activeElement).toBe(container.querySelector('[data-activity-toggle]'));
});

it('draws the controls as plain chips with an icon, Stop in the destructive tone', () => {
  render(
    <Bar
      line={QUIET}
      controls={{ paused: false, onPause: vi.fn(), onStop: vi.fn(), stopDisabled: true }}
    />,
  );
  const pause = within(reins()).getByRole('button', { name: en.Activity.pause });
  const stop = within(reins()).getByRole('button', { name: en.Activity.stop });
  for (const button of [pause, stop]) {
    expect(button).toHaveAttribute('type', 'button');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  }
  expect(pause.textContent).toBe(en.Activity.pause);
  expect(stop.className).toContain('text-destructive-foreground');
  expect(stop).toBeDisabled();
  expect(pause).toBeEnabled();
});
