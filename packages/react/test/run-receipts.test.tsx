import type { Receipt, ReceiptStatus, RunCommand } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandReceipts, useOpenReceipts } from '../src/components/CommandReceipts.tsx';
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

  it('puts a receipt on one line: its mark, the command, its boundary and its state', () => {
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
    expect(words(text)).toBe('Command · Boundary: after active work is settled · Accepted');
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
      'Command · Rejected · This operation was not allowed. Check the recorded reason. CAPABILITY_DENIED: Not allowed.',
    );
    expect(line?.querySelector('[data-status="rejected"]')).not.toBeNull();
    expect(line?.querySelector('details')).toBeNull();
  });

  it('leads a waiting pause with its own name and its boundary, the state after', () => {
    receiptLines({
      receipts: {
        cmd_pause: receipt('cmd_pause', 'accepted', { requestedBoundary: 'safe_boundary' }),
        cmd_resume: receipt('cmd_resume', 'queued', { requestedBoundary: 'next_request' }),
      },
      commandTypes: { cmd_pause: 'pause', cmd_resume: 'resume' },
    });
    expect(words(textOf(lineOf(screen.getByTestId('receipt-cmd_pause'))))).toBe(
      'Pause run · Boundary: after active work is settled · Accepted',
    );
    expect(words(textOf(lineOf(screen.getByTestId('receipt-cmd_resume'))))).toBe(
      'Resume run · Boundary: next model request · Queued',
    );
    expect(document.body.textContent).not.toContain('Whole-run command');
  });

  it('puts the state right after the name of a command that went wrong, before its reason', () => {
    receiptLines({
      receipts: {
        cmd_cancel: receipt('cmd_cancel', 'rejected', {
          error: { code: 'CAPABILITY_DENIED', message: 'Not allowed.' },
        }),
        cmd_expired: receipt('cmd_expired', 'expired', { requestedBoundary: 'safe_boundary' }),
      },
      commandTypes: { cmd_cancel: 'cancel', cmd_expired: 'pause' },
    });
    expect(words(textOf(lineOf(screen.getByTestId('receipt-cmd_cancel'))))).toBe(
      'Stop the run · Rejected · This operation was not allowed. Check the recorded reason. CAPABILITY_DENIED: Not allowed.',
    );
    expect(words(textOf(lineOf(screen.getByTestId('receipt-cmd_expired'))))).toBe(
      'Pause run · Expired · Boundary: after active work is settled',
    );
  });

  it('names any other command after the generic word, never by its type', () => {
    receiptLines({
      receipts: {
        cmd_approval: receipt('cmd_approval', 'accepted', { requestedBoundary: 'immediate' }),
      },
      commandTypes: { cmd_approval: 'resolve_approval' },
    });
    expect(words(textOf(lineOf(screen.getByTestId('receipt-cmd_approval'))))).toBe(
      'Command · Approval decision · Boundary: future admissions immediately · Accepted',
    );
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
      'Pause run · Receipt not confirmed. Check the run before retrying.',
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
    expect(words(tip)).toBe('Command · Boundary: after active work is settled · Accepted');
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

// A lost response is said once on the screen, in the product's words, never the browser's: in the
// run's head with its retry, or, for an instruction to one execution, in that execution's Reins,
// whose send goes again under the same ID.

const command = (type: RunCommand['type'], index: number, extra: object = {}) =>
  ({
    schemaVersion: '0.1',
    runId: 'run_receipts',
    commandId: `cmd_${index}`,
    type,
    payload: {},
    ...extra,
  }) as unknown as RunCommand;
const everyCommand: RunCommand[] = [
  command('pause', 1, { payload: { scope: 'run' } }),
  command('resume', 2, { payload: { scope: 'run' } }),
  command('cancel', 3, { payload: { scope: { kind: 'run' }, reason: 'stop' } }),
  command('cancel', 4, {
    payload: { scope: { kind: 'execution', executionId: 'exec_1' }, reason: 'x' },
  }),
  command('cancel', 5, { payload: { scope: { kind: 'task', taskId: 'task_1' }, reason: 'x' } }),
  command('steer', 6, {
    payload: { targetExecutionId: 'exec_1', text: 'Keep it short', delivery: 'next_request' },
  }),
  command('compact_context', 7, { payload: { executionId: 'exec_1', attemptNo: 1 } }),
  command('restart_task', 8, {
    payload: { taskId: 'task_1', previousExecutionId: 'exec_1', instruction: 'again' },
  }),
  command('resolve_approval', 9),
  command('answer_user', 10),
  command('answer_extension_ui', 11),
  command('patch', 12),
  command('set_breakpoints', 13, { payload: { nodeIds: [] } }),
  command('submit_advice', 14),
];

/** The run's head (with or without its controls, one line each or not) and exec_1's Reins. */
function screenWith(
  state: Partial<RunSessionState>,
  head: 'lines' | 'block' | 'controls' = 'lines',
) {
  const session = sessionStore({
    runId: 'run_receipts',
    projection: { ...emptyProjection('run_receipts'), status: 'running' },
    ...state,
  });
  function Open() {
    return (
      <output data-testid="open">{String(useOpenReceipts(session, 'run:run_receipts'))}</output>
    );
  }
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <section data-testid="head">
        {head === 'controls' ? (
          <RunActions session={session} compact />
        ) : (
          <RunActions
            session={session}
            compact
            narrowIcons
            receiptsOnly
            receiptLines={head === 'lines'}
          />
        )}
      </section>
      <section data-testid="reins">
        <CommandReceipts session={session} target="execution:exec_1" />
      </section>
      <Open />
    </IntlProvider>,
  );
  return session;
}
const statements = (scope: HTMLElement) => scope.textContent?.match(/not confirmed/g)?.length ?? 0;

describe('a lost response, said once', () => {
  it.each(['lines', 'block', 'controls'] as const)(
    'says each lost command once, in its place, in the product’s words (%s head)',
    (head) => {
      for (const lostCommand of everyCommand) {
        cleanup();
        screenWith(
          {
            commandError: 'Failed to fetch',
            unconfirmedCommands: {
              [lostCommand.commandId]: { command: lostCommand, error: 'Failed to fetch' },
            },
          },
          head,
        );
        const where = lostCommand.type === 'steer' ? 'reins' : 'head';
        const other = where === 'reins' ? 'head' : 'reins';
        expect(statements(screen.getByTestId(where)), `${lostCommand.type} in its place`).toBe(1);
        expect(statements(screen.getByTestId(other)), `${lostCommand.type} elsewhere`).toBe(0);
        expect(document.body.textContent, lostCommand.type).not.toContain('Failed to fetch');
        expect(screen.getAllByRole('alert'), lostCommand.type).toHaveLength(1);
        // The head has a retry for what it says; the Reins sends again from its own field.
        expect(
          within(screen.getByTestId('head')).queryAllByRole('button', {
            name: 'Check receipt and retry safely',
          }),
          lostCommand.type,
        ).toHaveLength(where === 'head' ? 1 : 0);
        expect(
          within(screen.getByTestId('reins')).queryAllByRole('button', {
            name: 'Check receipt and retry safely',
          }),
        ).toHaveLength(0);
        expect(screen.getByTestId('open').textContent, lostCommand.type).toBe(
          String(where === 'head'),
        );
      }
    },
  );

  it('adds no row to the run head for a lost instruction to one execution', () => {
    const steer = everyCommand.find((c) => c.type === 'steer') as RunCommand;
    screenWith({
      commandError: 'Failed to fetch',
      unconfirmedCommands: { [steer.commandId]: { command: steer, error: 'Failed to fetch' } },
    });
    const head = screen.getByTestId('head');
    expect(head.querySelectorAll('[data-slot="receipt-line"]')).toHaveLength(0);
    expect(within(head).queryByRole('group')).toBeNull();
    expect(head.textContent).toBe('');
    expect(screen.getByTestId('open').textContent).toBe('false');
  });

  it('says a connection error with no lost command once, in the run’s head, in the product’s words', () => {
    for (const head of ['block', 'controls'] as const) {
      cleanup();
      screenWith({ commandError: 'Failed to fetch' }, head);
      expect(statements(screen.getByTestId('head')), head).toBe(1);
      expect(statements(screen.getByTestId('reins')), head).toBe(0);
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Receipt not confirmed. Check the run before retrying.',
      );
      expect(document.body.textContent).not.toContain('Failed to fetch');
    }
  });
});

// Every kind of command by a name, never by its type: a whole-run control by its run name, any
// other after the generic word.

const names: Record<string, string> = {
  cmd_1: 'Pause run',
  cmd_2: 'Resume run',
  cmd_3: 'Stop the run',
  cmd_4: 'Command · Cancel',
  cmd_5: 'Command · Cancel',
  cmd_7: 'Command · Compaction',
  cmd_8: 'Command · Restart task',
  cmd_9: 'Command · Approval decision',
  cmd_10: 'Command · Answer',
  cmd_11: 'Command · Extension answer',
  cmd_12: 'Command · Settings change',
  cmd_13: 'Command · Pause before steps',
  cmd_14: 'Command · Advice',
};

describe('a command’s name', () => {
  it.each(['lines', 'block'] as const)(
    'names each lost command in the run’s head, with no type and no whole-run word for others (%s)',
    (head) => {
      for (const lostCommand of everyCommand.filter((c) => c.type !== 'steer')) {
        cleanup();
        screenWith(
          {
            unconfirmedCommands: {
              [lostCommand.commandId]: { command: lostCommand, error: 'Failed to fetch' },
            },
          },
          head,
        );
        const text = words(screen.getByTestId('head')) ?? '';
        const name = names[lostCommand.commandId] as string;
        expect(text.startsWith(name), `${lostCommand.commandId}: ${text}`).toBe(true);
        expect(text, lostCommand.commandId).not.toContain(lostCommand.type);
        expect(text, lostCommand.commandId).not.toContain('Whole-run command');
      }
    },
  );

  it('names a receipt in the titled block by its command', () => {
    const session = sessionStore({
      runId: 'run_receipts',
      projection: { ...emptyProjection('run_receipts'), status: 'running' },
      receipts: {
        cmd_pause: receipt('cmd_pause', 'accepted', { requestedBoundary: 'safe_boundary' }),
        cmd_patch: receipt('cmd_patch', 'queued'),
      },
      commandTypes: { cmd_pause: 'pause', cmd_patch: 'patch' },
    });
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunActions session={session} compact />
      </IntlProvider>,
    );
    expect(words(screen.getByTestId('receipt-cmd_pause'))).toContain('Pause run · Accepted');
    expect(words(screen.getByTestId('receipt-cmd_patch'))).toContain(
      'Command · Settings change · Queued',
    );
    expect(document.body.textContent).not.toContain('Whole-run command');
  });

  it('names an instruction to one execution in its Reins', () => {
    const session = sessionStore({
      runId: 'run_receipts',
      projection: { ...emptyProjection('run_receipts'), status: 'running' },
      receipts: {
        cmd_steer: receipt('cmd_steer', 'queued', {
          target: 'execution:exec_1',
          requestedBoundary: 'next_request',
        }),
      },
      commandTypes: { cmd_steer: 'steer' },
    });
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <CommandReceipts session={session} target="execution:exec_1" />
      </IntlProvider>,
    );
    expect(words(screen.getByTestId('receipt-cmd_steer'))).toContain(
      'Command · Instruction · Queued',
    );
  });
});
