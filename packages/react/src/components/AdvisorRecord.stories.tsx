import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { advisorDefinition, advisorRunSession } from '../stories/advisorRunFixture.ts';
import { ExecutionSteering } from './ExecutionSteering.tsx';
import { RunCanvas } from './RunCanvas.tsx';
import { ExecutionTree } from './RunView.tsx';
import { Timeline } from './Timeline.tsx';

// A run whose Reviewer advisor watches the Implementer: one admitted concern and one dropped
// note (docs/specs/features/advisor.md, execution-monitor.md "관계·판단 기록").

const session = advisorRunSession();

function AdvisorRecord() {
  return (
    <div className="grid w-[74rem] grid-cols-[minmax(0,46rem)_minmax(0,26rem)] items-start gap-6">
      <div className="h-[46rem]">
        <Timeline session={session} fill />
      </div>
      <div className="h-[46rem]">
        <RunCanvas
          session={session}
          definition={advisorDefinition()}
          selectedNodeId={null}
          onSelectNode={() => {}}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Run/Advisor record',
  component: AdvisorRecord,
} satisfies Meta<typeof AdvisorRecord>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The run record: the admitted advice as a Graph relation, the dropped one as a judgment only. */
export const RelationAndJudgment: Story = {
  play: async ({ canvasElement }) => {
    // Names are isolated in their own elements, so the sentences are read as the record's text.
    await waitFor(() =>
      expect(canvasElement.textContent).toContain(
        'Reviewer advised Implementer (Concern), for its next request',
      ),
    );
    expect(canvasElement.textContent).toContain(
      'Advice from Reviewer dropped (Note): already given',
    );
    // The Graph draws the advisor's line to the Implementer once, with its count.
    await waitFor(() => expect(canvasElement.innerHTML).toContain('Advice 1'));
    // The Graph's cards fade in; the a11y check runs after play, once no text still fades (a
    // running agent's halo pulses for as long as it runs, and is not read).
    await waitFor(
      () => {
        for (const element of canvasElement.querySelectorAll('*'))
          if (!element.closest('[aria-hidden="true"]'))
            expect(getComputedStyle(element).opacity).toBe('1');
      },
      { timeout: 3000 },
    );
  },
};

/** The Implementer's directives: the advice carries its advisor and severity. */
export const DirectiveList: Story = {
  render: () => (
    <div className="w-[32rem]">
      <ExecutionSteering
        session={session}
        target={{ executionId: 'impl_1', nodeLabel: 'Implementer', finished: false }}
        compose={null}
        planSlot={null}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-directive-advice]')?.textContent).toBe(
        'Reviewer · Concern',
      ),
    );
    expect(canvas.getByText('Keep the comparison to one page.')).toBeVisible();
  },
};

/** The execution tree: a team's advisor keeps its name and says it is one, and rests watching. */
export const ExecutionTreeRow: Story = {
  render: () => (
    <div className="w-[40rem]">
      <ExecutionTree session={session} onSteer={() => {}} wideCards />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const advisor = within(
      canvasElement.querySelector<HTMLElement>('[data-testid="execution-advisor_1"]') ??
        canvasElement,
    );
    await waitFor(() => expect(advisor.getByText('Advisor')).toBeVisible());
    expect(advisor.getByText('Watching')).toBeVisible();
  },
};

const conversationSession = advisorRunSession({ session: true });

/** The advisor a conversation adds has no name of its own: it is called Advisor, once. */
export const ConversationAdvisorRow: Story = {
  render: () => (
    <div className="w-[40rem]">
      <ExecutionTree session={conversationSession} onSteer={() => {}} wideCards />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const advisor = within(
      canvasElement.querySelector<HTMLElement>('[data-testid="execution-advisor_1"]') ??
        canvasElement,
    );
    await waitFor(() => expect(advisor.getAllByText('Advisor')).toHaveLength(1));
    expect(advisor.getByText('Watching')).toBeVisible();
  },
};
