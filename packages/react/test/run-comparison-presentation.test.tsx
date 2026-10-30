import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { RunComparison } from '../src/components/RunComparison.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith } from '../src/stories/fixtures.tsx';

it('keeps unknown run names generic and exact identifiers inside the existing disclosure', () => {
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunComparison
        a={{
          projection: projectionWith({
            runId: 'run_unlabelled_first',
            startedAt: '2026-10-30T01:00:00Z',
          }),
          name: null,
          output: 'First result',
        }}
        b={{
          projection: projectionWith({
            runId: 'run_unlabelled_second',
            startedAt: '2026-10-30T02:00:00Z',
          }),
          name: null,
          output: 'Second result',
        }}
      />
    </IntlProvider>,
  );
  expect(screen.queryByRole('heading', { name: 'run_unlabelled_first' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'run_unlabelled_second' })).not.toBeInTheDocument();
  expect(document.querySelector('time[datetime="2026-10-30T01:00:00Z"]')).not.toBeNull();
});
