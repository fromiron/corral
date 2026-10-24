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

  it('[TC-ULTRA-004-N] a version 2 Ultra run shows usage without an allowance and never counts unknown usage as zero', () => {
    const session = createRunSession({} as never);
    const p = emptyProjection('run_unlimited');
    p.usageLimits = 'none';
    p.budget = {
      spent: 42,
      reserved: 1_000_000,
      unknownOutstanding: 1_000_000,
      modelCalls: 3,
      reservations: {
        call_live: {
          modelCallId: 'call_live',
          scope: 'e',
          reserved: 1_000_000,
          actual: null,
          status: 'reserved',
        },
        call_unknown: {
          modelCallId: 'call_unknown',
          scope: 'e',
          reserved: 1_000_000,
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
    expect(screen.getByRole('note')).toHaveTextContent('No default usage limits');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByText(/1,000,000/)).not.toBeInTheDocument();
    expect(screen.getByText('Confirmed output tokens').nextSibling).toHaveTextContent('42');
    expect(screen.getByText('Calls in progress').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Calls with unknown usage').nextSibling).toHaveTextContent('1');
  });
});
