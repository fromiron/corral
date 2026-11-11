import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { RunFlowView } from '../src/components/RunFlowView.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { loopFlowFixture } from '../src/stories/loopFlowFixture.ts';

const fixture = (count = 100) =>
  loopFlowFixture(
    count,
    vi.fn(async () => {}),
  );

function renderFlow(selectedExecutionId?: string) {
  const data = fixture();
  const onSelectExecution = vi.fn();
  const rendered = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunFlowView
        session={data.session}
        definition={data.definition}
        selectedExecutionId={selectedExecutionId}
        onSelectExecution={onSelectExecution}
        onOpenArtifact={vi.fn()}
      />
    </IntlProvider>,
  );
  return { ...data, ...rendered, onSelectExecution };
}

describe('bounded loop flow', () => {
  it('represents 100 observed rounds with one loop and one round of cards', () => {
    const { container, projection, loadArtifact } = renderFlow();
    expect(screen.getAllByTestId('run-flow-loop')).toHaveLength(1);
    expect(screen.getByText('100 observed rounds · max 3')).toBeInTheDocument();
    expect(screen.getAllByTestId('decision-detail')).toHaveLength(1);
    const artifacts = screen.getByRole('region', { name: 'Created results' });
    expect(within(artifacts).queryByText('Draft round 1')).toBeNull();
    expect(within(artifacts).getByText('Draft round 100')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-selected="true"]')).toHaveLength(1);
    expect(projection.loopIterations.review_loop).toHaveLength(100);
    expect(loadArtifact).not.toHaveBeenCalled();
  });

  it('pins exact relationship metadata through new rounds and clears the pin for another Run', async () => {
    const user = userEvent.setup();
    const { session, projection, onSelectExecution, loadArtifact } = renderFlow();
    await user.click(screen.getByRole('combobox', { name: 'Round for Review' }));
    await user.click(await screen.findByRole('option', { name: 'Round 2' }));
    const artifacts = screen.getByRole('region', { name: 'Created results' });
    expect(within(artifacts).getByText('Draft round 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Draft round 2' })).toBeNull();
    expect(onSelectExecution).not.toHaveBeenCalled();
    expect(session.getState().projection).toBe(projection);
    expect(loadArtifact).not.toHaveBeenCalled();
    act(() => session.setState({ projection: fixture(101).projection }));
    expect(within(artifacts).getByText('Draft round 2')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Round for Review' })).toHaveTextContent('Round 2');
    const nextRun = { ...fixture(1).projection, runId: 'another_run' };
    act(() => session.setState({ runId: nextRun.runId, projection: nextRun }));
    expect(screen.getByRole('combobox', { name: 'Round for Review' })).toHaveTextContent(
      'Follow latest round',
    );
    expect(screen.queryByText('This round is unavailable')).toBeNull();
  });

  it('reveals the linked execution round instead of replacing it with the latest round', () => {
    renderFlow('writer_2');
    expect(screen.getByRole('combobox', { name: 'Round for Review' })).toHaveTextContent('Round 2');
    expect(
      within(screen.getByRole('region', { name: 'Created results' })).getByText('Draft round 2'),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('decision-detail')).toHaveLength(1);
  });
  it('follows new rounds after choosing latest despite an unchanged earlier execution link', async () => {
    const user = userEvent.setup();
    const { session, onSelectExecution } = renderFlow('writer_2');
    const choose = async (label: string) => {
      await user.click(screen.getByRole('combobox', { name: 'Round for Review' }));
      // The list renders a moment after the click under load.
      await user.click(await screen.findByRole('option', { name: label }));
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    };
    await choose('Follow latest round');
    expect(screen.getByRole('combobox', { name: 'Round for Review' })).toHaveTextContent(
      'Follow latest round',
    );
    const newer = fixture(101).projection;
    act(() => session.setState({ projection: newer }));
    expect(
      within(screen.getByRole('region', { name: 'Created results' })).getByText('Draft round 101'),
    ).toBeInTheDocument();
    expect(onSelectExecution).not.toHaveBeenCalled();
  });
});
