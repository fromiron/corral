import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { DecisionInbox } from '../design-kit/index.ts';

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

const meta = {
  title: 'Studio/DecisionInbox',
  component: DecisionInbox,
  decorators: [(Story) => <div className="w-[28rem] max-w-full">{Story()}</div>],
  args: {
    onDecide: fn(),
    labels: { region: '결정' },
    heading: (count: number) => `${count}건이 답을 기다립니다`,
    clearHeading: '기다리는 결정이 없습니다',
    emptyLabel: '기다리는 결정이 없습니다.',
    decisions: [],
  },
} satisfies Meta<typeof DecisionInbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ApproveOrReject: Story = {
  args: {
    decisions: [
      {
        id: 'run-shell',
        title: '터미널에서 npm test를 실행할까요?',
        detail: '작업 폴더: apps/server\n실행 파일: bash',
        primary: { label: '승인', doneLabel: '승인했습니다' },
        secondary: { label: '거절', doneLabel: '거절했습니다' },
      },
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('1건이 답을 기다립니다')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: '승인' }));
    await expect(args.onDecide).toHaveBeenCalledWith('run-shell', 'primary');
    await expect(await canvas.findByRole('status')).toHaveTextContent('승인했습니다');
    await settled(canvasElement);
  },
};

export const WithChoices: Story = {
  args: {
    decisions: [
      {
        id: 'publish-target',
        title: '결과를 어디에 정리할까요?',
        detail: '보고서 초안이 두 가지 형식으로 준비되어 있습니다.',
        primary: { label: '문서로 정리', doneLabel: '문서로 정리했습니다' },
        secondary: { label: '슬라이드로 정리', doneLabel: '슬라이드로 정리했습니다' },
      },
      {
        id: 'older-notes',
        title: '이전 메모를 함께 넣을까요?',
        primary: { label: '넣기' },
        secondary: { label: '빼기' },
        folded: true,
      },
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '슬라이드로 정리' }));
    await expect(args.onDecide).toHaveBeenCalledWith('publish-target', 'secondary');
    await userEvent.click(canvas.getByRole('button', { name: '이전 메모를 함께 넣을까요?' }));
    await expect(canvas.getByRole('button', { name: '넣기' })).toBeInTheDocument();
    await settled(canvasElement);
  },
};

export const ContinueOrStop: Story = {
  args: {
    decisions: [
      {
        id: 'request-budget',
        title: '요청 예산 400회에 닿았습니다',
        detail: '지금까지 400회를 썼고 작업은 마지막 검토 단계입니다.',
        primary: { label: '계속', doneLabel: '계속합니다' },
        secondary: { label: '멈춤', doneLabel: '멈췄습니다' },
      },
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '멈춤' }));
    await expect(args.onDecide).toHaveBeenCalledWith('request-budget', 'secondary');
    await expect(await canvas.findByRole('status')).toHaveTextContent('멈췄습니다');
    await settled(canvasElement);
  },
};
