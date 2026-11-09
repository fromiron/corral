import type { Receipt, ReceiptStatus } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { RunActions } from '../src/components/RunActions.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';

// docs/specs/features/execution-monitor.md: the run header keeps only receipts that need you.

const receipt = (commandId: string, status: ReceiptStatus, extra: Partial<Receipt> = {}) =>
  ({
    commandId,
    runId: 'run_receipts',
    status,
    acceptedSeq: 1,
    target: 'run:run_receipts',
    requestedBoundary: 'immediate',
    relatedEventIds: [],
    ...extra,
  }) satisfies Receipt;

function header(receipts: Receipt[], status: 'running' | 'succeeded' = 'succeeded') {
  const session = sessionStore({
    runId: 'run_receipts',
    projection: { ...emptyProjection('run_receipts'), status },
    receipts: Object.fromEntries(receipts.map((r) => [r.commandId, r])),
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunActions session={session} compact />
    </IntlProvider>,
  );
}

const shown = () =>
  screen.queryAllByTestId(/^receipt-/).map((row) => row.getAttribute('data-testid'));

describe('run header receipts', () => {
  it('drops receipts whose command applied, was superseded or was cancelled', () => {
    header([
      receipt('cmd_applied', 'applied'),
      receipt('cmd_superseded', 'superseded'),
      receipt('cmd_cancelled', 'cancelled'),
    ]);
    expect(shown()).toEqual([]);
    expect(screen.queryByText('Command receipts')).toBeNull();
  });

  it('keeps receipts still waiting and those that went wrong', () => {
    header(
      [
        receipt('cmd_applied', 'applied'),
        receipt('cmd_accepted', 'accepted'),
        receipt('cmd_queued', 'queued'),
        receipt('cmd_rejected', 'rejected', {
          error: { code: 'CAPABILITY_DENIED', message: 'Not allowed.' },
        }),
        receipt('cmd_expired', 'expired'),
      ],
      'running',
    );
    expect(shown()).toEqual([
      'receipt-cmd_accepted',
      'receipt-cmd_queued',
      'receipt-cmd_rejected',
      'receipt-cmd_expired',
    ]);
  });
});
