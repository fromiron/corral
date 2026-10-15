import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { BudgetInspector } from '../src/components/BudgetInspector.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { createRunSession } from '../src/run/session.ts';

describe('BudgetInspector (C-061)', () => {
  it('keeps confirmed, reserved and unknown usage distinct; unavailable cost is never zero', () => {
    const session = createRunSession({} as never);
    const p = emptyProjection('run_budget');
    p.budget = {
      spent: 42,
      reserved: 100,
      unknownOutstanding: 300,
      modelCalls: 3,
      reservations: {
        call_unknown: {
          modelCallId: 'call_unknown',
          scope: 'exec_budget',
          reserved: 300,
          actual: null,
          status: 'unknown',
        },
      },
    };
    session.setState({ projection: p, definition: linearCorral(['writer']) });
    render(
      <IntlProvider locale="en" messages={messages}>
        <BudgetInspector session={session} />
      </IntlProvider>,
    );
    expect(screen.getByText('Confirmed output tokens').nextSibling).toHaveTextContent('42');
    expect(screen.getByText('Reserved output tokens').nextSibling).toHaveTextContent('100');
    expect(screen.getByText('Unconfirmed output tokens held').nextSibling).toHaveTextContent('300');
    expect(screen.getByText('Estimated cost').nextSibling).toHaveTextContent('Unavailable');
    expect(
      within(screen.getByTestId('budget-call-call_unknown')).getByText('Unknown'),
    ).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });
});
