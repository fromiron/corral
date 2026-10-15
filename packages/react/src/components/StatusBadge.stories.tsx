import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusBadge } from './StatusBadge.tsx';

const STATUSES = [
  'queued',
  'running',
  'active',
  'attached_to_request',
  'delivered',
  'succeeded',
  'completed',
  'expired',
  'not_delivered',
  'delivery_unknown',
  'cancelled',
  'failed',
  'rejected',
  'awaiting_user',
];

const meta = { title: 'Status/StatusBadge', component: StatusBadge } satisfies Meta<
  typeof StatusBadge
>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AllStatuses: Story = {
  args: { status: 'queued' },
  render: () => (
    <ul className="flex flex-wrap gap-2">
      {STATUSES.map((status) => (
        <li key={status}>
          <StatusBadge status={status} />
        </li>
      ))}
    </ul>
  ),
};
