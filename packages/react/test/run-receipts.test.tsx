import type { Receipt, ReceiptStatus } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunActions } from '../src/components/RunActions.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import type { RunSessionState } from '../src/run/session.ts';
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

// A head that carries only receipts (the run tab beside the conversation, decision 18 of the
// session panel) keeps each receipt to one line: its mark, the command, its state and the
// boundary or reason, cut at the end and whole in the kit tooltip.

function receiptLines(state: Partial<RunSessionState>) {
  const session = sessionStore({
    runId: 'run_receipts',
    projection: { ...emptyProjection('run_receipts'), status: 'pausing' },
    ...state,
  });
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunActions session={session} compact narrowIcons receiptsOnly receiptLines />
    </IntlProvider>,
  );
  return session;
}

const words = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, ' ').trim();
const lineOf = (element: Element) => element.closest('[data-slot="receipt-line"]');
const textOf = (line: Element | null) =>
  line?.querySelector<HTMLElement>('[data-slot="receipt-line-text"]') ?? null;
const lost = (commandId: string, error = 'response lost') => ({
  error,
  command: {
    schemaVersion: '0.1' as const,
    runId: 'run_receipts',
    commandId,
    type: 'pause' as const,
    payload: { scope: 'run' as const },
  },
});

describe('a head of receipts only, one line each', () => {
  afterEach(() => vi.restoreAllMocks());

  it('puts a receipt on one line: its mark, the command, its state and its boundary', () => {
    receiptLines({
      receipts: {
        cmd_pause: receipt('cmd_pause', 'accepted', { requestedBoundary: 'safe_boundary' }),
      },
    });
    const row = screen.getByTestId('receipt-cmd_pause');
    const line = lineOf(row);
    expect(line).not.toBeNull();
    const text = textOf(line);
    expect(text).toHaveClass('truncate');
    expect(words(text)).toBe(
      'Whole-run command · Accepted · Boundary: after active work is settled',
    );
    // One mark, before the words and silent: the state is said in words.
    const marks = line?.querySelectorAll('[data-slot="receipt-mark"]') ?? [];
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAttribute('aria-hidden', 'true');
    expect(marks[0]?.querySelector('[data-status="accepted"]')).not.toBeNull();
    expect(line?.querySelectorAll('p')).toHaveLength(0);
  });

  it('names the group of receipts without a heading on screen', () => {
    receiptLines({
      receipts: {
        cmd_pause: receipt('cmd_pause', 'accepted'),
        cmd_resume: receipt('cmd_resume', 'queued'),
      },
    });
    const group = screen.getByRole('group', { name: 'Command receipts' });
    expect(within(group).getAllByTestId(/^receipt-/)).toHaveLength(2);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByText('Command receipts')).toBeNull();
  });

  it('says why a rejected command went wrong as its tail, the sentence before the record', () => {
    receiptLines({
      receipts: {
        cmd_rejected: receipt('cmd_rejected', 'rejected', {
          error: { code: 'CAPABILITY_DENIED', message: 'Not allowed.' },
        }),
      },
    });
    const line = lineOf(screen.getByTestId('receipt-cmd_rejected'));
    expect(words(textOf(line))).toBe(
      'Whole-run command · Rejected · This operation was not allowed. Check the recorded reason. CAPABILITY_DENIED: Not allowed.',
    );
    expect(line?.querySelector('[data-status="rejected"]')).not.toBeNull();
    expect(line?.querySelector('details')).toBeNull();
  });

  it('says a lost response once, on its line with the retry, without the browser’s words', () => {
    const retryCommand = vi.fn(async () => ({}) as Receipt);
    // A lost response leaves both: the command unconfirmed and the session's connection error.
    receiptLines({
      retryCommand,
      commandError: 'Failed to fetch',
      unconfirmedCommands: { cmd_lost: lost('cmd_lost', 'Failed to fetch') },
    });
    const lines = document.querySelectorAll('[data-slot="receipt-line"]');
    expect(lines).toHaveLength(1);
    const group = screen.getByRole('group', { name: 'Command receipts' });
    const retry = within(group).getByRole('button', { name: 'Check receipt and retry safely' });
    const line = lineOf(retry);
    expect(line).toBe(lines[0]);
    expect(words(textOf(line))).toBe(
      'Whole-run command · pause · Receipt not confirmed. Check the run before retrying.',
    );
    expect(document.body.textContent?.match(/not confirmed/g)).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Failed to fetch');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(lineOf(screen.getByRole('alert'))).toBe(line);
    expect(line?.querySelector('[data-slot="receipt-mark"]')).not.toBeNull();
    // An icon on the line; its words stay its name.
    expect(retry.querySelector('svg')).not.toBeNull();
    expect(retry.querySelector('.sr-only')).toHaveTextContent('Check receipt and retry safely');
    fireEvent.click(retry);
    expect(retryCommand).toHaveBeenCalledWith('cmd_lost');
  });

  it('puts a connection error with no receipt row on one line, in the product’s words only', () => {
    receiptLines({ commandError: 'Failed to fetch' });
    const lines = document.querySelectorAll('[data-slot="receipt-line"]');
    expect(lines).toHaveLength(1);
    const alert = screen.getByRole('alert');
    const line = lineOf(alert);
    expect(line).toBe(lines[0]);
    expect(textOf(line)).toHaveClass('truncate');
    expect(words(textOf(line))).toBe('Receipt not confirmed. Check the run before retrying.');
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  it('shows a cut line whole in the kit tooltip, and lets the keyboard reach it', async () => {
    const cut = (element: HTMLElement) => element.dataset.slot === 'receipt-line-text';
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return cut(this) ? 480 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return cut(this) ? 200 : 0;
    });
    receiptLines({
      receipts: {
        cmd_pause: receipt('cmd_pause', 'accepted', { requestedBoundary: 'safe_boundary' }),
      },
    });
    const text = textOf(lineOf(screen.getByTestId('receipt-cmd_pause')));
    expect(text).toHaveAttribute('tabindex', '0');
    await userEvent.tab();
    expect(text).toHaveFocus();
    const tip = await screen.findByRole('tooltip');
    expect(words(tip)).toBe(
      'Whole-run command · Accepted · Boundary: after active work is settled',
    );
  });

  it('leaves a line that fits out of the tab order, with no tooltip', async () => {
    receiptLines({ receipts: { cmd_pause: receipt('cmd_pause', 'accepted') } });
    const text = textOf(lineOf(screen.getByTestId('receipt-cmd_pause')));
    expect(text).not.toBeNull();
    expect(text).not.toHaveAttribute('tabindex');
    await userEvent.tab();
    expect(text).not.toHaveFocus();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps the titled block where the head does not ask for lines', () => {
    const session = sessionStore({
      runId: 'run_receipts',
      projection: { ...emptyProjection('run_receipts'), status: 'succeeded' },
      receipts: {
        cmd_pause: receipt('cmd_pause', 'accepted', { requestedBoundary: 'safe_boundary' }),
      },
    });
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunActions session={session} compact narrowIcons receiptsOnly />
      </IntlProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Command receipts' })).toBeInTheDocument();
    expect(screen.getByText('Boundary: after active work is settled').tagName).toBe('P');
    expect(screen.queryByRole('group', { name: 'Command receipts' })).toBeNull();
  });
});
