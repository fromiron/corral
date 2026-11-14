import type { CorralDefinition } from '@corral/contracts';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import { RunFlowDecisions } from '../src/components/RunFlowDecisions.tsx';
import { ExecutionTree, useRoundInspection } from '../src/components/RunView.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import type { RunSessionStore } from '../src/run/session.ts';
import { loopFlowFixture } from '../src/stories/loopFlowFixture.ts';

// #191: the run page's work flow shows the tree and the decisions of one inspected round.

function Flow({
  session,
  definition,
  selectedExecutionId,
}: {
  session: RunSessionStore;
  definition: CorralDefinition;
  selectedExecutionId: string | null;
}) {
  const projection = useStore(session, (s) => s.projection);
  const rounds = useRoundInspection(projection, selectedExecutionId);
  return (
    <>
      <ExecutionTree
        session={session}
        onSteer={vi.fn()}
        selectedExecutionId={selectedExecutionId}
        rounds={rounds}
      />
      <RunFlowDecisions
        session={session}
        definition={definition}
        onOpenArtifact={vi.fn()}
        selectedIterations={rounds.selected}
      />
    </>
  );
}

function renderFlow(selectedExecutionId: string | null) {
  const data = loopFlowFixture(3);
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <Flow session={data.session} definition={data.definition} {...{ selectedExecutionId }} />
    </IntlProvider>,
  );
  return data;
}

/** The evidence the decisions panel lists, as its text. */
const evidence = () => screen.getByTestId('run-flow-decisions');

describe('work flow rounds', () => {
  it('shows the decision of the round the selected execution ran in', () => {
    renderFlow('writer_1');
    expect(evidence()).toHaveTextContent('Result · Draft round 1');
    expect(evidence()).not.toHaveTextContent('Draft round 3');
  });

  it('keeps a round chosen in the tree for the decisions through new rounds', async () => {
    const user = userEvent.setup();
    const { session } = renderFlow(null);
    expect(evidence()).toHaveTextContent('Result · Draft round 3');
    await user.click(screen.getByRole('combobox', { name: 'Round for Review' }));
    await user.click(await screen.findByRole('option', { name: 'Round 2' }));
    expect(evidence()).toHaveTextContent('Result · Draft round 2');
    act(() => session.setState({ projection: loopFlowFixture(4).projection }));
    expect(evidence()).toHaveTextContent('Result · Draft round 2');
  });
});
