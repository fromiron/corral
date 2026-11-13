import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { advisorDefinition, advisorRunSession } from '../stories/advisorRunFixture.ts';
import { ExecutionSteering } from './ExecutionSteering.tsx';
import { RunFlowView } from './RunFlowView.tsx';
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
      <RunFlowView
        session={session}
        definition={advisorDefinition()}
        onSelectExecution={() => {}}
        onOpenArtifact={() => {}}
      />
    </div>
  );
}

const meta = {
  title: 'Run/Advisor record',
  component: AdvisorRecord,
} satisfies Meta<typeof AdvisorRecord>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The run record: the admitted advice as a relation, the dropped one as a judgment only. */
export const RelationAndJudgment: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByText('Reviewer advised Implementer (Concern), for its next request'),
      ).toBeVisible(),
    );
    expect(canvas.getByText('Advice from Reviewer dropped (Note): already given')).toBeVisible();
    expect(canvas.getAllByText('Concern · Next request · Queued').length).toBeGreaterThan(0);
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
    await waitFor(() => expect(canvas.getByText('Reviewer · Concern')).toBeVisible());
    expect(canvas.getByText('Keep the comparison to one page.')).toBeVisible();
  },
};

/** The execution tree: the advisor says it is one, by its name, and rests watching. */
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
