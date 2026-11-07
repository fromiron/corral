import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { ExecutionToolGroup } from '../src/components/ExecutionTranscript.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };

it.each([
  { status: 'waiting' as const, label: 'Paused' },
  { status: 'waiting' as const, label: 'Waiting for approval' },
  { status: 'stopped' as const, label: 'Cancelled' },
])('keeps unfinished tools $label without active animation or false success', (activityState) => {
  const { container } = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ExecutionToolGroup
        activityState={activityState}
        tools={[
          {
            kind: 'tool',
            seq: 1,
            toolCallId: 'pending',
            name: 'read_document',
            status: 'allowed',
            detail: null,
            resultRef: null,
            args: { path: 'source.md' },
          },
          {
            kind: 'tool',
            seq: 2,
            toolCallId: 'done',
            name: 'search',
            status: 'finished',
            detail: null,
            resultRef: null,
            args: {},
          },
        ]}
      />
    </IntlProvider>,
  );
  const pending = screen.getByRole('button', { name: /^read_document/ });
  expect(pending).toHaveTextContent(activityState.label);
  expect(pending.closest('[data-status]')).toHaveAttribute('data-status', activityState.status);
  expect(screen.getByRole('button', { name: /^search/ }).closest('[data-status]')).toHaveAttribute(
    'data-status',
    'success',
  );
  fireEvent.click(pending);
  expect(container.querySelector('.shimmer-text')).toBeNull();
  expect(container.querySelector('.pulse-soft')).toBeNull();
});
