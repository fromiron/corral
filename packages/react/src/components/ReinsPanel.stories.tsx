import type { DirectiveStatus, Receipt } from '@corral/contracts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { projectionWith, sessionStore } from '../stories/fixtures.tsx';
import { ReinsPanel } from './ReinsPanel.tsx';

const target = { executionId: 'exec_0002', nodeLabel: 'Writer', finished: false };

function withDirectives(
  items: { text: string; status: DirectiveStatus }[],
  receipt?: Receipt['status'],
) {
  const directives = Object.fromEntries(
    items.map((item, index) => [
      `dir_000${index + 1}`,
      {
        directiveId: `dir_000${index + 1}`,
        targetExecutionId: target.executionId,
        text: item.text,
        status: item.status,
        commandId: `cmd_${index + 1}`,
        acceptedSeq: index + 10,
        contextSnapshotId: null,
        modelCallId: null,
        reason: null,
      },
    ]),
  );
  const receipts: Record<string, Receipt> = receipt
    ? {
        cmd_1: {
          commandId: 'cmd_1',
          runId: 'run_story',
          status: receipt,
          acceptedSeq: 10,
          target: `execution:${target.executionId}`,
          requestedBoundary: 'next_request',
          relatedEventIds: [],
        },
      }
    : {};
  return sessionStore({
    runId: 'run_story',
    receipts,
    projection: projectionWith({ directives, directiveOrder: Object.keys(directives) }),
  });
}

const meta = {
  title: 'Reins/ReinsPanel',
  component: ReinsPanel,
  decorators: [(Story) => <div className="w-88">{Story()}</div>],
} satisfies Meta<typeof ReinsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoTarget: Story = { args: { session: sessionStore(), target: null } };

export const Queued: Story = {
  args: {
    session: withDirectives([{ text: 'Use primary sources only.', status: 'queued' }], 'queued'),
    target,
  },
};

export const Delivered: Story = {
  args: {
    session: withDirectives(
      [{ text: 'Use primary sources only.', status: 'delivered' }],
      'applied',
    ),
    target,
  },
};

export const ExpiredAfterFinish: Story = {
  args: {
    session: withDirectives([{ text: 'Use primary sources only.', status: 'expired' }], 'expired'),
    target: { ...target, finished: true },
  },
};

export const LongKoreanAndJapanese: Story = {
  args: {
    session: withDirectives([
      {
        text: '1차 자료만 근거로 사용하고, 확인하지 못한 항목은 따로 표시해 주세요. 표와 결론은 짧게 유지합니다.',
        status: 'delivered',
      },
      { text: '一次資料のみを根拠とし、未確認の項目は区別してください。', status: 'queued' },
    ]),
    target,
  },
};
