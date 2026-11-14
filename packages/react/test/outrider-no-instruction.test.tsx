import { fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionTree, RunView } from '../src/components/RunView.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { useSteerTarget } from '../src/run/steer-target.ts';
import { advisorRunSession } from '../src/stories/advisorRunFixture.ts';

// An Outrider takes no instruction from a person (features/advisor.md "보이는 곳";
// execution-monitor.md, Reins): the fixture's advisor_1 is an Outrider still working, and the
// latest execution of the run; impl_1 is the role it watches.

const wrap =
  (locale: 'en' | 'ko' = 'en') =>
  ({ children }: { children: ReactNode }) => (
    <IntlProvider locale={locale} messages={locale === 'en' ? en : ko} timeZone="UTC">
      {children}
    </IntlProvider>
  );

describe.each([{ session: false }, { session: true }])('the Reins target (%o)', (options) => {
  const target = (chosen: string | null) =>
    renderHook(() => useSteerTarget(advisorRunSession(options), chosen), { wrapper: wrap() }).result
      .current;

  it('an Outrider’s execution named as the target is no target, never another execution', () => {
    expect(target('advisor_1')).toBeNull();
  });

  it('with none named, the latest working execution that is not an Outrider is the target', () => {
    expect(target(null)?.executionId).toBe('impl_1');
  });

  it('an ordinary execution named as the target stays the target', () => {
    expect(target('impl_1')?.executionId).toBe('impl_1');
  });
});

describe('the execution tree that picks whom to instruct', () => {
  it.each(['en', 'ko'] as const)(
    'keeps the Outrider’s card readable but no control; the watched role’s card picks (%s)',
    (locale) => {
      const onSteer = vi.fn();
      // The conversation's own Outrider, called by the one word.
      render(
        <ExecutionTree session={advisorRunSession({ session: true })} onSteer={onSteer} steers />,
        { wrapper: wrap(locale) },
      );
      const advisor = screen.getByTestId('execution-advisor_1');
      // Static content like the run's root card: no control and not in the tab order.
      expect(within(advisor).queryByRole('button')).toBeNull();
      expect(advisor.hasAttribute('tabindex')).toBe(false);
      // Its tree item carries its name and state.
      const status = advisor.querySelector('[data-presence-label="execution:advisor_1"]');
      expect(status?.textContent).toBeTruthy();
      expect(
        screen.getByRole('treeitem', { name: `Outrider: ${status?.textContent}` }),
      ).toContainElement(advisor);
      const worker = screen.getByTestId('execution-impl_1');
      const pick = within(worker).getAllByRole('button')[0];
      if (!pick) throw new Error('the watched role’s card has no control');
      fireEvent.click(pick);
      expect(onSteer).toHaveBeenCalledWith('impl_1');
      expect(onSteer).not.toHaveBeenCalledWith('advisor_1');
    },
  );

  it('a tree that only selects what to read still selects the Outrider', () => {
    const onSelect = vi.fn();
    render(<ExecutionTree session={advisorRunSession()} onSteer={onSelect} />, {
      wrapper: wrap(),
    });
    const advisor = screen.getByTestId('execution-advisor_1');
    const select = within(advisor).getAllByRole('button')[0];
    if (!select) throw new Error('the Outrider’s card has no control');
    fireEvent.click(select);
    expect(onSelect).toHaveBeenCalledWith('advisor_1');
  });

  it('the editor’s run pane tree is one that picks whom to instruct', () => {
    const onSteer = vi.fn();
    render(<RunView session={advisorRunSession({ session: true })} onSteer={onSteer} />, {
      wrapper: wrap(),
    });
    const advisor = screen.getByTestId('execution-advisor_1');
    expect(within(advisor).queryByRole('button')).toBeNull();
  });
});
