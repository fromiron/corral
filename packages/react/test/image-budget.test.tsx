import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { BudgetInspector } from '../src/components/BudgetInspector.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';

it('shows image microdollars separately from tokens and labels held estimates as unconfirmed', () => {
  const projection = emptyProjection('run_image');
  projection.budget = {
    ...projection.budget,
    imageSpentMicros: 125001,
    imageReservedMicros: 200000,
    imageUnknownOutstandingMicros: 300000,
    reservations: {
      image_call: {
        modelCallId: null,
        scope: 'exec_image',
        reserved: 0,
        actual: 0,
        status: 'unknown',
        image: { profileId: 'images', reservedMicros: 300000, actualMicros: null },
      },
    },
  };
  render(
    <IntlProvider locale="en" messages={messages}>
      <BudgetInspector
        session={sessionStore({ projection, definition: linearCorral(['writer']) })}
      />
    </IntlProvider>,
  );
  expect(screen.getByText('Image cost confirmed').nextElementSibling).toHaveTextContent(
    '$0.125001',
  );
  expect(screen.getByText('Image budget reserved').nextElementSibling).toHaveTextContent('$0.20');
  expect(
    screen.getByText('Image cost unknown · held estimate').nextElementSibling,
  ).toHaveTextContent('$0.30');
  expect(screen.getByText(/It is not a confirmed charge/)).toBeInTheDocument();
  expect(screen.getByTestId('budget-call-image_call')).toHaveTextContent('Image cost not reported');
  expect(screen.getByTestId('budget-call-image_call')).toHaveTextContent('$0.30 held');
});

it('leaves image rows absent for runs with no image ledger', () => {
  render(
    <IntlProvider locale="en" messages={messages}>
      <BudgetInspector
        session={sessionStore({
          projection: emptyProjection('run_text'),
          definition: linearCorral(['writer']),
        })}
      />
    </IntlProvider>,
  );
  expect(screen.queryByText('Image cost confirmed')).not.toBeInTheDocument();
  expect(screen.queryByText(/held estimate/i)).not.toBeInTheDocument();
});
