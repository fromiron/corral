import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { TermHint, TermTooltip } from '../src/components/TermHint.tsx';
import { Button } from '../src/design-kit/index.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

// features/term-hints.md: a coined name explains itself in one sentence where it stands as a name,
// by an info icon after a title or in the tooltip a control already has.

const corral = en.Terms.corral;

function show(node: React.ReactNode, locale: 'en' | 'ko' = 'en') {
  return render(
    <IntlProvider locale={locale} messages={locale === 'en' ? en : ko} timeZone="UTC">
      <h2>Corrals {node}</h2>
      <p>Below the title</p>
    </IntlProvider>,
  );
}

const hint = () => screen.getByRole('button', { name: 'About Corral' });
const shown = () => screen.queryByText(corral.meaning, { selector: '[data-term-meaning]' });

it('names the icon after its term and reads the meaning as its description while closed', () => {
  show(<TermHint term="corral" />);
  expect(hint()).toHaveAccessibleName('About Corral');
  expect(hint()).toHaveAccessibleDescription(corral.meaning);
  // Drawn only when open.
  expect(shown()).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('opens on a press, showing the name and its one sentence, and closes on a press outside', async () => {
  const user = userEvent.setup();
  show(<TermHint term="corral" />);
  await user.click(hint());
  await waitFor(() => expect(shown()).not.toBeNull());
  const name = screen.getByText(corral.name, { selector: '[data-term-name]' });
  expect(name).toBeVisible();
  await user.click(screen.getByText('Below the title'));
  await waitFor(() => expect(shown()).toBeNull());
});

it('opens on keyboard focus; Escape closes it and leaves the focus on the icon', async () => {
  const user = userEvent.setup();
  show(<TermHint term="corral" />);
  await user.tab();
  expect(hint()).toHaveFocus();
  await waitFor(() => expect(shown()).not.toBeNull());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(shown()).toBeNull());
  expect(hint()).toHaveFocus();
});

it('opens when the pointer rests on the icon', async () => {
  const user = userEvent.setup();
  show(<TermHint term="corral" />);
  await user.hover(hint());
  await waitFor(() => expect(shown()).not.toBeNull());
});

it('says the name and meaning in the screen language', async () => {
  const user = userEvent.setup();
  show(<TermHint term="advisor" />, 'ko');
  const icon = screen.getByRole('button', { name: '감독 설명' });
  expect(icon).toHaveAccessibleDescription(ko.Terms.advisor.meaning);
  await user.click(icon);
  await waitFor(() =>
    expect(
      screen.getByText(ko.Terms.advisor.meaning, { selector: '[data-term-meaning]' }),
    ).toBeVisible(),
  );
  expect(screen.getByText('감독', { selector: '[data-term-name]' })).toBeVisible();
});

it('in a control’s tooltip, keeps the control’s name, adds the meaning as its description and no icon', async () => {
  const user = userEvent.setup();
  render(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <TermTooltip term="advisor">
        <Button variant="ghost" aria-label="Advisor settings">
          A
        </Button>
      </TermTooltip>
    </IntlProvider>,
  );
  const control = screen.getByRole('button', { name: 'Advisor settings' });
  expect(control).toHaveAccessibleDescription(en.Terms.advisor.meaning);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  await user.hover(control);
  const tip = await screen.findByRole('tooltip');
  expect(tip.querySelector('[data-term-name]')?.textContent).toBe(en.Terms.advisor.name);
  expect(tip.querySelector('[data-term-meaning]')?.textContent).toBe(en.Terms.advisor.meaning);
  expect(control).toHaveAccessibleName('Advisor settings');
});

it('has the same Terms keys in both languages, each term with a name and a meaning', () => {
  const keys = (tree: object, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string' ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`),
    );
  expect(keys(ko.Terms).sort()).toEqual(keys(en.Terms).sort());
  for (const [id, value] of Object.entries(en.Terms))
    if (id !== 'about') expect(Object.keys(value).sort(), id).toEqual(['meaning', 'name']);
});
