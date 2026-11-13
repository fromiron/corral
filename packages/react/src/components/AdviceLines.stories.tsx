import type { RunProjection } from '@corral/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useId, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RunRow, RunTail } from '../../../../apps/studio/src/workbench/RunRow.tsx';
import { TurnProcess } from '../../../../apps/studio/src/workbench/TurnProcess.tsx';
import { agentName, unreadAdviceOf } from '../run/advisor.ts';
import { advisorRunSession, endedRun, withAdvice } from '../stories/advisorRunFixture.ts';
import { AdviceSummary, AdviceText } from './AdviceLine.tsx';
import { ExecutionTranscript } from './ExecutionTranscript.tsx';

// An advisor's advice where the conversation and the run record draw it (docs/specs/features/
// advisor.md 보이는 곳): a step in its target's work, saying how its delivery stands; advice its
// target never read, written into the run row's tail line; and that advice at the end of its
// target's record.

const session = advisorRunSession();
const start = session.getState().projection as RunProjection;
const events = session.getState().events;
const definition = session.getState().definition;
const label = (nodeId: string) => agentName(definition, nodeId, 'Advisor');

/** The fixture's concern read, a blocker that cut a response, and a note waiting. */
const delivered = (() => {
  const projection = withAdvice(start, [
    {
      adviceId: 'a_cut',
      severity: 'blocker',
      text: 'Stop: the migration drops the sessions table.\nKeep the old table until the copy is checked.',
      status: 'delivered',
      modelCallId: 'call_impl_2',
    },
    { adviceId: 'a_note', severity: 'nit', text: 'Name the new file after its table.' },
  ]);
  const call = projection.modelCalls.call_impl_1 as RunProjection['modelCalls'][string];
  return {
    ...projection,
    directives: {
      ...projection.directives,
      dir_advice_1: {
        ...(projection.directives.dir_advice_1 as RunProjection['directives'][string]),
        status: 'delivered' as const,
      },
    },
    modelCalls: {
      ...projection.modelCalls,
      call_impl_1: { ...call, interrupted: true as const },
      call_impl_2: { ...call, modelCallId: 'call_impl_2' },
    },
  };
})();

/** The name of the role that answers, which the head line of its work carries. */
const answering = 'Implementer';

function Work({ projection }: { projection: RunProjection }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="w-[44rem] max-w-full">
      <TurnProcess
        events={events}
        // Its clock stands still at the record's last event, so the picture holds.
        projection={{ ...projection, status: 'awaiting_user' }}
        streams={{}}
        label={label}
        open={open}
        onOpenChange={setOpen}
        role={answering}
        status="Running"
      />
    </div>
  );
}

/** A run row's tail with the advice its target never read, as the conversation draws it. */
function Tail({
  projection,
  initiallyOpen = false,
}: {
  projection: RunProjection;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const id = useId();
  const unread = unreadAdviceOf(projection);
  const nameOf = (item: (typeof unread)[number]) =>
    label(projection.executions[item.observerExecutionId]?.nodeId ?? '');
  return (
    <div className="w-[44rem] max-w-full">
      <RunRow
        head={<p className="text-caption text-muted-foreground">Implementer · Succeeded · 42s</p>}
        tail={
          <>
            <RunTail values={[{ key: 'changes', node: '2 changes' }]}>
              <AdviceSummary
                name={unread[0] ? nameOf(unread[0]) : ''}
                items={unread}
                open={open}
                controls={id}
                onToggle={() => setOpen((value) => !value)}
              />
            </RunTail>
            <AdviceText
              id={id}
              open={open}
              items={unread}
              nameOf={nameOf}
              className="text-caption"
            />
          </>
        }
      >
        <p>The login waits on the session cache; the fix keeps one cache per worker.</p>
      </RunRow>
    </div>
  );
}

const lateOne = endedRun(
  withAdvice(start, [
    {
      adviceId: 'a_late',
      severity: 'blocker',
      text: '\n\nThe answer blames the cache without a measurement. Measure the login request before and after the change, or the fix may not touch the slow path at all.',
      status: 'expired',
    },
  ]),
);
const lateMany = endedRun(
  withAdvice(start, [
    {
      adviceId: 'a_late',
      severity: 'concern',
      text: 'The totals skip the last row of each page.',
      status: 'expired',
    },
    {
      adviceId: 'a_later',
      severity: 'blocker',
      text: 'The export writes over the shared report without asking.',
      status: 'expired',
    },
  ]),
);
const kept = endedRun(
  withAdvice(start, [
    {
      adviceId: 'a_kept',
      severity: 'concern',
      text: 'The summary counts drafts as published.\nFilter on the published flag first.',
      delivery: 'preserve',
    },
  ]),
);

/** The work log's steps grow and fade in; the a11y check runs after play, once nothing fades. */
async function settled(canvasElement: HTMLElement) {
  await waitFor(
    () => {
      for (const element of canvasElement.querySelectorAll('*'))
        if (!element.closest('[hidden]'))
          expect(getComputedStyle(element).opacity, element.outerHTML.slice(0, 200)).toBe('1');
    },
    { timeout: 3000 },
  );
}

const meta = {
  title: 'Run/Advice lines',
  component: Work,
  args: { projection: delivered },
} satisfies Meta<typeof Work>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Delivered, interrupting and waiting, each a step of the implementer's work. */
export const InTheWork: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        [...canvasElement.querySelectorAll('[data-advice-state]')].map((node) => node.textContent),
      ).toEqual([
        'Read',
        'Interrupted · delivered by cutting the reply',
        'Waiting to join · read at the next step',
      ]),
    );
    await settled(canvasElement);
  },
};

/** The same, with the blocker's words open. */
export const InTheWorkOpen: Story = {
  play: async ({ canvasElement }) => {
    const lines = await within(canvasElement).findAllByRole('button', { expanded: false });
    const blocker = lines.find((line) => line.textContent?.startsWith('Blocker'));
    if (!blocker) throw new Error('no blocker line');
    await userEvent.click(blocker);
    await waitFor(() =>
      expect(
        document.getElementById(blocker.getAttribute('aria-controls') ?? '')?.closest('[hidden]'),
      ).toBeNull(),
    );
    await settled(canvasElement);
  },
};

/** One advice its target never read, in the tail's own line. */
export const TailOne: Story = {
  render: () => <Tail projection={lateOne} />,
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-advice-line]')?.textContent).toMatch(
        /^Reviewer·Blocker·The answer blames the cache/,
      ),
    );
  },
};

export const TailOneOpen: Story = {
  render: () => <Tail projection={lateOne} initiallyOpen />,
};

/** Several: the advisor, the gravest severity and how many; open, every one in full. */
export const TailSeveral: Story = {
  render: () => <Tail projection={lateMany} />,
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-advice-line]')?.textContent).toBe(
        'Reviewer·Blocker·2 pieces of advice',
      ),
    );
  },
};

export const TailSeveralOpen: Story = {
  render: () => <Tail projection={lateMany} initiallyOpen />,
};

/** The record of a run outside a conversation: the kept advice at its target's end. */
export const RecordEnd: Story = {
  render: () => {
    const store = advisorRunSession();
    store.setState({ projection: kept });
    return (
      <div className="h-[36rem] w-[44rem] max-w-full">
        <ExecutionTranscript session={store} executionId="impl_1" adviceOpen />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelector('[data-advice="unread"] [data-advice-line]')?.textContent,
      ).toBe('Reviewer·Concern·The summary counts drafts as published.'),
    );
  },
};
