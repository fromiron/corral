import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { ActivityBar, type ActivityBarRole } from '../src/components/ActivityBar.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

// features/composer-flow.md "활동 바": at narrow widths a role row stays one line; the activity
// gives way first, then the name truncates with an ellipsis. The whole name is its tooltip, and
// the buttons' accessible names keep the whole name.

const LONG = 'Implementation reviewer for the release candidate branch';

function role(overrides: Partial<ActivityBarRole>): ActivityBarRole {
  return {
    id: 'role_1',
    name: LONG,
    glyph: 'running',
    tone: 'active',
    stateShown: false,
    working: true,
    activity: 'Reading the diff',
    startedAt: 0,
    target: false,
    onShow: vi.fn(),
    onJoin: vi.fn(),
    ...overrides,
  };
}

function show(roles: ActivityBarRole[], locale: 'en' | 'ko') {
  return render(
    <IntlProvider locale={locale} messages={locale === 'en' ? en : ko} timeZone="UTC">
      <ActivityBar line={{ glyph: 'running', tone: 'active', text: 'Works' }} roles={roles} open />
    </IntlProvider>,
  );
}

it.each(['en', 'ko'] as const)(
  'a long role name truncates with its whole name as the tooltip; the buttons keep it (%s)',
  (locale) => {
    const messages = locale === 'en' ? en : ko;
    show([role({}), role({ id: 'role_2', name: `${LONG} two`, target: true })], locale);
    const list = screen.getByRole('list', { name: messages.Activity.roles });
    const [first, second] = within(list).getAllByRole('listitem');
    if (!first || !second) throw new Error('two rows expected');

    const name = within(first).getByText(LONG, { exact: true });
    expect(name).toHaveAttribute('title', LONG);
    // It may shrink below its text and ends in an ellipsis instead of pushing the actions out.
    expect(name).toHaveClass('min-w-0', 'truncate');
    expect(name).not.toHaveClass('shrink-0');

    expect(
      within(first).getByRole('button', {
        name: messages.Activity.viewRole.replace('{name}', LONG),
      }),
    ).toHaveTextContent(messages.Activity.view);
    expect(
      within(first).getByRole('button', {
        name: messages.Activity.joinRole.replace('{name}', LONG),
      }),
    ).toHaveTextContent(messages.Activity.join);

    // The join target's mark stays whole in its row too.
    expect(within(second).getByText(`${LONG} two`, { exact: true })).toHaveAttribute(
      'title',
      `${LONG} two`,
    );
    expect(within(second).getByText(messages.Activity.joinTarget)).toBeInTheDocument();
    expect(within(second).queryByRole('button', { name: /join|합류/i })).toBeNull();
  },
);
