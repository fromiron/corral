import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useRef, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { type Decision, DecisionInbox, type DecisionInboxProps } from '../design-kit/index.ts';

// Rows, the heading and the pill fade in on springs, and the a11y check runs after play:
// wait until nothing in the canvas is still fading.
async function settled(canvasElement: HTMLElement) {
  await waitFor(
    () => {
      for (const el of canvasElement.querySelectorAll('*')) {
        expect(getComputedStyle(el).opacity).toBe('1');
      }
    },
    { timeout: 3000 },
  );
}

const budget: Decision = {
  id: 'request-budget',
  title: '요청 예산 400회에 닿았습니다',
  detail: '지금까지 400회를 썼고 작업은 마지막 검토 단계입니다.',
  primary: { label: '계속', doneLabel: '계속합니다' },
  secondary: { label: '멈춤', doneLabel: '멈췄습니다' },
};

const loopRound: Decision = {
  id: 'loop-round',
  title: 'Loop 4회차를 계속할까요?',
  detail: '3회차까지 끝났고 남은 회차는 6회입니다.',
  primary: { label: '계속', doneLabel: '계속합니다' },
  secondary: { label: '멈춤', doneLabel: '멈췄습니다' },
};

const meetingChain: Decision = {
  id: 'meeting-chain',
  title: '회의를 다음 발언자로 이어갈까요?',
  primary: { label: '이어가기', doneLabel: '이어갑니다' },
  secondary: { label: '마무리', doneLabel: '마무리했습니다' },
  folded: true,
};

// Corral's flow: a click sends the response, the row waits (`pending`), the receipt
// brings the `resolution`, and the host then drops the row.
function ReceiptFlow(props: DecisionInboxProps) {
  const [decisions, setDecisions] = useState(props.decisions);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) window.clearTimeout(t);
    };
  }, []);
  const decide: NonNullable<DecisionInboxProps['onDecide']> = (id, choice) => {
    props.onDecide?.(id, choice);
    setDecisions((all) => all.map((d) => (d.id === id ? { ...d, pending: true } : d)));
    timers.current.push(
      window.setTimeout(() => {
        setDecisions((all) =>
          all.map((d) => {
            if (d.id !== id) return d;
            const action = choice === 'primary' ? d.primary : d.secondary;
            return { ...d, pending: false, resolution: action?.doneLabel ?? action?.label };
          }),
        );
      }, 400),
      window.setTimeout(() => setDecisions((all) => all.filter((d) => d.id !== id)), 1600),
    );
  };
  return <DecisionInbox {...props} decisions={decisions} onDecide={decide} />;
}

const meta = {
  title: 'Conversation/DecisionInbox',
  component: DecisionInbox,
  decorators: [(Story) => <div className="w-[28rem] max-w-full">{Story()}</div>],
  args: {
    onDecide: fn(),
    optimistic: false,
    labels: { region: '결정' },
    heading: (n: number) => (n > 0 ? `결정 ${n}건` : '모두 답했습니다'),
    clearHeading: '결정 없음',
    emptyLabel: '대기 중인 결정이 없습니다',
    decisions: [budget],
  },
} satisfies Meta<typeof DecisionInbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ContinueOrStop: Story = {
  render: (args) => <ReceiptFlow {...args} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '계속' }));
    await expect(args.onDecide).toHaveBeenCalledWith('request-budget', 'primary');
    // Sent, receipt not back yet: no confirmation, buttons wait.
    await expect(canvas.queryByRole('status')).toBeNull();
    await expect(canvas.getByRole('button', { name: '계속' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: '멈춤' })).toBeDisabled();
    // The receipt arrives: the confirmation shows.
    await expect(await canvas.findByRole('status')).toHaveTextContent('계속합니다');
    // The host drops the answered row.
    await waitFor(() => expect(canvas.queryByText('요청 예산 400회에 닿았습니다')).toBeNull(), {
      timeout: 4000,
    });
    await settled(canvasElement);
  },
};

export const SeveralWaiting: Story = {
  args: { decisions: [loopRound, meetingChain] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: '계속' })).toBeInTheDocument();
    const folded = canvas.getByRole('button', { name: '회의를 다음 발언자로 이어갈까요?' });
    await expect(folded).toHaveAttribute('aria-expanded', 'false');
    for (let i = 0; i < 5 && document.activeElement !== folded; i += 1) await userEvent.tab();
    await expect(folded).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const answer = await canvas.findByRole('button', { name: '이어가기' });
    for (let i = 0; i < 5 && document.activeElement !== answer; i += 1) await userEvent.tab();
    await expect(answer).toHaveFocus();
    await settled(canvasElement);
  },
};

export const Dark: Story = {
  args: { decisions: [loopRound, meetingChain] },
  decorators: [(Story) => <div className="dark bg-background p-3 text-foreground">{Story()}</div>],
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
  },
};
