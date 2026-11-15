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

// Two open executions of one role are told apart by their place at the name's end (" · #2"): the
// name before it shortens, the place never does, and the parts joined are the whole name.
it.each(['en', 'ko'] as const)(
  'keeps the place that tells same-role rows apart whole (%s)',
  (locale) => {
    const messages = locale === 'en' ? en : ko;
    show(
      [
        role({ id: 'a', name: 'Planner · #2', place: ' · #2' }),
        role({ id: 'b', name: 'Planner · #3', place: ' · #3' }),
      ],
      locale,
    );
    const list = screen.getByRole('list', { name: messages.Activity.roles });
    for (const [index, row] of within(list).getAllByRole('listitem').entries()) {
      const full = `Planner · #${index + 2}`;
      const name = row.querySelector<HTMLElement>(`[title="${full}"]`);
      if (!name) throw new Error('the name carries its whole as the tooltip');
      expect(name.textContent).toBe(full);
      const [base, place] = [...name.children] as HTMLElement[];
      expect(base?.textContent).toBe('Planner');
      // The name before the place truncates (inside its floor, NameFloor).
      expect(base?.querySelector('.truncate')).toHaveClass('min-w-0', 'truncate');
      expect(base?.querySelector('.truncate')?.textContent).toBe('Planner');
      expect(place?.textContent).toBe(` · #${index + 2}`);
      expect(place).toHaveClass('shrink-0');
      expect(place).not.toHaveClass('truncate');
      expect(
        within(row).getByRole('button', {
          name: messages.Activity.viewRole.replace('{name}', full),
        }),
      ).toBeInTheDocument();
      expect(
        within(row).getByRole('button', {
          name: messages.Activity.joinRole.replace('{name}', full),
        }),
      ).toBeInTheDocument();
    }
  },
);

const joinColumn = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-activity-join]');

// A list where no row can be joined (a meeting) keeps no join place: View stands at the right end.
it('keeps no join place when no row can be joined', () => {
  show(
    [
      role({ id: 'a', name: 'Participant 1', onJoin: undefined }),
      role({ id: 'b', name: 'Participant 2', onJoin: undefined }),
    ],
    'en',
  );
  for (const row of screen.getAllByRole('listitem')) {
    expect(joinColumn(row)).toBeNull();
    expect(row.lastElementChild).toContainElement(
      within(row).getByRole('button', { name: /^View / }),
    );
  }
  // The list has no column for it either.
  expect(screen.getByRole('list').className).not.toMatch(/7rem/);
});

// Where any row can be joined, every row keeps the join place, an Outrider's too: the rows share
// the list's columns, so View and the join place stand at the same spot in each.
it('gives every row the same join place when one row can be joined, the Outrider included', () => {
  show(
    [
      role({ id: 'a', name: 'Writer', target: true }),
      role({ id: 'b', name: 'Reviewer' }),
      role({ id: 'c', name: 'Outrider', onJoin: undefined }),
    ],
    'en',
  );
  const list = screen.getByRole('list');
  const rows = within(list).getAllByRole('listitem');
  // The rows are the list's own columns: one for the role, View and the join place.
  expect(list).toHaveClass('grid');
  for (const row of rows) {
    expect(row).toHaveClass('grid-cols-subgrid', 'col-span-full');
    expect(row.children).toHaveLength(3);
    expect(row.lastElementChild).toBe(joinColumn(row));
  }
  const [target, joinable, outrider] = rows as [HTMLElement, HTMLElement, HTMLElement];
  expect(joinColumn(target)).toHaveTextContent(en.Activity.joinTarget);
  expect(within(target).queryByRole('button', { name: 'Join Writer' })).toBeNull();
  expect(
    within(joinColumn(joinable) as HTMLElement).getByRole('button', { name: 'Join Reviewer' }),
  ).toBeInTheDocument();
  expect(joinColumn(outrider)).toBeEmptyDOMElement();
  expect(within(outrider).queryByRole('button', { name: /^Join / })).toBeNull();
  expect(
    within(outrider)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual([en.Activity.view]);
});

// A row that writes its state in words: the words shorten with the name, never over the place
// or View. Their whole is the tooltip; the name never shrinks below its place.
it.each([
  ['en', 'Waiting for you'],
  ['ko', '일시정지하는 중'],
] as const)('lets written state words shorten with the name (%s)', (locale, words) => {
  show(
    [
      role({
        id: 'a',
        name: 'plan · #2',
        place: ' · #2',
        working: false,
        stateShown: true,
        state: { text: words, target: 'execution:a' },
        activity: undefined,
      }),
    ],
    locale,
  );
  const row = screen.getByRole('listitem');
  const state = within(row).getByText(words).closest('[title]') as HTMLElement;
  expect(state).toHaveAttribute('title', words);
  expect(state).toHaveClass('min-w-0', 'truncate');
  expect(state).not.toHaveClass('shrink-0');
  // The name shortens, the place inside it does not; the name's box never gets narrower than
  // its place (it keeps its automatic minimum).
  const name = row.querySelector('[title="plan · #2"]') as HTMLElement;
  expect(name).not.toHaveClass('min-w-0');
  expect(name.lastElementChild).toHaveClass('shrink-0');
  // The name shortens first, down to a floor of its first letters; then the words shorten.
  expect(name.firstElementChild).toHaveAttribute('data-floor', 'plan');
  expect(state).toHaveClass('shrink-[0.0001]');
  // Nothing in the role's cell is drawn outside it.
  expect(row.firstElementChild).toHaveClass('overflow-hidden');
});

// A place that is not the end of the name is not a place: the row shows the whole name as one.
it('shows the whole name when the place is not its end', () => {
  show([role({ id: 'a', name: 'Writer', place: ' · #2' })], 'en');
  const name = screen.getByText('Writer', { exact: true });
  expect(name).toHaveAttribute('title', 'Writer');
  expect(name.children).toHaveLength(0);
  expect(screen.queryByText(/#2/)).toBeNull();
});

// The activity leaves the screen when it has no room, never the accessibility tree.
it('keeps the activity for assistive technology', () => {
  show([role({ id: 'a', name: 'Writer', activity: 'Reading the diff' })], 'en');
  const activity = screen.getByText('Reading the diff');
  expect(activity.closest('[aria-hidden="true"]')).toBeNull();
  expect(activity).toHaveAttribute('title', 'Reading the diff');
});
